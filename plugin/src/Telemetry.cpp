#include "Telemetry.h"

#include "Character.h"
#include "Discovery.h"
#include "FormKey.h"
#include "Json.h"
#include "Player.h"
#include "Quests.h"

#include <excpt.h>
#include <format>
#include <vector>

namespace
{
    using Json::AppendEscaped;
    using Json::Finite;

    constexpr std::size_t kActorsPerPacket = 24;  // keeps every datagram a few KB
    constexpr auto kQuestPeriod = std::chrono::seconds(1);
    constexpr auto kSlowPeriod = std::chrono::seconds(5);  // discovery, inventory, magic

    std::atomic<bool> g_running{ false };
    std::atomic<bool> g_taskPending{ false };
    std::thread g_worker;
    // Rates can change from the in-game menu while the worker runs.
    std::atomic<int> g_playerHz{ 10 };
    std::atomic<int> g_actorHz{ 2 };
    std::atomic<int> g_maxActors{ 120 };
    std::string g_gameDir;
    std::string g_mo2Dir;
    std::uint32_t g_actorSeq = 0;

    // ---------------------------------------------------------------- cost report
    // How much game-thread time the map takes, logged every 30 s, so a low frame rate
    // can be ruled in or out without guessing.
    using Clock = std::chrono::steady_clock;
    constexpr auto kReportPeriod = std::chrono::seconds(30);

    struct Cost
    {
        const char* name;
        double      totalMs = 0.0;
        double      maxMs = 0.0;
        int         runs = 0;

        void Add(Clock::time_point start)
        {
            const double ms = std::chrono::duration<double, std::milli>(Clock::now() - start).count();
            totalMs += ms;
            maxMs = std::max(maxMs, ms);
            ++runs;
        }
    };
    Cost g_costState{ "state" };
    Cost g_costActors{ "actors" };
    Cost g_costQuests{ "quests+player" };
    Cost g_costSlow{ "places+inventory+magic" };
    Clock::time_point g_nextReport = Clock::now() + kReportPeriod;

    void ReportCosts()
    {
        const auto now = Clock::now();
        if (now < g_nextReport) {
            return;
        }
        const double seconds = std::chrono::duration<double>(kReportPeriod + (now - g_nextReport)).count();
        g_nextReport = now + kReportPeriod;
        double total = 0.0;
        std::string detail;
        for (auto* cost : { &g_costState, &g_costActors, &g_costQuests, &g_costSlow }) {
            total += cost->totalMs;
            detail += std::format("  {} {}x avg {:.2f} ms max {:.2f} ms;", cost->name, cost->runs,
                cost->runs ? cost->totalMs / cost->runs : 0.0, cost->maxMs);
            *cost = Cost{ cost->name };
        }
        SKSE::log::info("Game-thread cost: {:.1f} ms per second ({:.2f}% of one core).{} Relay: {}.", total / seconds, total / seconds / 10.0, detail, Relay::Status());
    }

    // ---------------------------------------------------------------- crash guard
    // The quest and player-stats packets call into game code whose layout can differ
    // between game versions. If one ever faults, turn that packet off for the session
    // and log it, instead of taking the game down with it.
    using PacketBuilder = std::vector<std::string> (*)(RE::PlayerCharacter*);

    void BuildInto(PacketBuilder build, RE::PlayerCharacter* player, std::vector<std::string>* out)
    {
        *out = build(player);
    }

    // No C++ objects in this frame: required for __try. /EHa (see CMakeLists) still
    // runs destructors, e.g. lock guards, in the frames being unwound.
    bool TryBuild(PacketBuilder build, RE::PlayerCharacter* player, std::vector<std::string>* out)
    {
        __try {
            BuildInto(build, player, out);
            return true;
        } __except (EXCEPTION_EXECUTE_HANDLER) {
            return false;
        }
    }

    struct GuardedPacket
    {
        const char*       name;
        PacketBuilder     build;
        std::atomic<bool> enabled{ true };
    };
    GuardedPacket g_questPacket{ "quest markers", [](RE::PlayerCharacter* p) { return std::vector{ Quests::Packet(p) }; } };
    GuardedPacket g_playerPacket{ "player stats", [](RE::PlayerCharacter* p) { return std::vector{ Player::Packet(p) }; } };
    GuardedPacket g_discoveryPacket{ "discovered places", Discovery::Packets };
    GuardedPacket g_inventoryPacket{ "inventory", Character::InventoryPackets };
    GuardedPacket g_magicPacket{ "magic", Character::MagicPackets };

    void SendGuarded(GuardedPacket& packet, RE::PlayerCharacter* player)
    {
        if (!packet.enabled) {
            return;
        }
        std::vector<std::string> packets;
        if (TryBuild(packet.build, player, &packets)) {
            for (const auto& json : packets) {
                Relay::Send(json);
            }
        } else {
            packet.enabled = false;
            SKSE::log::error("Reading {} crashed; {} are turned off until the game restarts. Please report this.", packet.name, packet.name);
        }
    }

    float HealthPercent(RE::Actor* actor)
    {
        auto* av = actor->AsActorValueOwner();
        const float max = av->GetPermanentActorValue(RE::ActorValue::kHealth);
        const float cur = av->GetActorValue(RE::ActorValue::kHealth);
        return max > 0.0f && std::isfinite(cur) ? std::clamp(cur / max, 0.0f, 1.0f) : 0.0f;
    }

    const char* Disposition(RE::Actor* actor, RE::PlayerCharacter* player)
    {
        if (actor->IsDead()) {
            return "dead";
        }
        if (actor->IsPlayerTeammate() || actor->IsCommandedActor()) {
            return "ally";
        }
        if (actor->IsHostileToActor(player)) {
            return "hostile";
        }
        return "neutral";
    }

    std::string ActorJson(RE::Actor* actor, RE::PlayerCharacter* player)
    {
        const auto pos = actor->GetPosition();
        std::string json = std::format("{{\"id\":{},\"x\":{:.0f},\"y\":{:.0f},\"z\":{:.0f},\"h\":{:.3f},\"lvl\":{},\"hp\":{:.2f},\"combat\":{},\"npc\":{},\"state\":\"{}\",\"name\":",
            actor->GetFormID(), Finite(pos.x), Finite(pos.y), Finite(pos.z), Finite(actor->GetAngleZ()), actor->GetLevel(), HealthPercent(actor),
            actor->IsInCombat() ? "true" : "false",
            actor->HasKeywordString("ActorTypeNPC") ? "true" : "false",
            Disposition(actor, player));
        AppendEscaped(json, actor->GetDisplayFullName());
        json += ",\"race\":";
        const auto* race = actor->GetRace();
        AppendEscaped(json, race ? race->GetFullName() : nullptr);
        json += '}';
        return json;
    }

    // Actors go out in small numbered batches: a busy exterior in a big modlist holds
    // over a hundred, and one bad or oversized packet must not lose the whole list.
    void SendActors(RE::PlayerCharacter* player)
    {
        auto* lists = RE::ProcessLists::GetSingleton();
        if (!lists) {
            return;
        }
        std::vector<std::string> entries;
        for (auto& handle : lists->highActorHandles) {
            if (entries.size() >= static_cast<std::size_t>(g_maxActors.load())) {
                break;
            }
            auto actorPtr = handle.get();
            auto* actor = actorPtr.get();
            if (!actor || actor == player || actor->IsDisabled()) {
                continue;
            }
            entries.push_back(ActorJson(actor, player));
        }

        const auto seq = ++g_actorSeq;
        const std::size_t parts = std::max<std::size_t>(1, (entries.size() + kActorsPerPacket - 1) / kActorsPerPacket);
        for (std::size_t part = 0; part < parts; ++part) {
            const std::size_t first = part * kActorsPerPacket;
            const std::size_t last = std::min(entries.size(), first + kActorsPerPacket);
            std::string json = std::format("{{\"t\":\"actors\",\"seq\":{},\"part\":{},\"parts\":{},\"actors\":[", seq, part, parts);
            for (std::size_t i = first; i < last; ++i) {
                if (i > first) {
                    json += ',';
                }
                json += entries[i];
            }
            json += "]}";
            Relay::Send(json);
        }
    }

    // Runs on the game's main thread via the SKSE task queue.
    void Collect(bool includeActors, bool includeQuests, bool includeSlow)
    {
        auto* player = RE::PlayerCharacter::GetSingleton();
        if (!player || !player->GetParentCell()) {
            return;
        }

        auto start = Clock::now();
        const auto pos = player->GetPosition();
        const auto* cell = player->GetParentCell();
        const auto* world = player->GetWorldspace();
        const auto* location = player->GetCurrentLocation();
        const bool interior = cell->IsInteriorCell();

        std::string json;
        json.reserve(512);
        json += std::format("{{\"t\":\"state\",\"x\":{:.1f},\"y\":{:.1f},\"z\":{:.1f},\"h\":{:.4f},\"interior\":{},\"ws\":{},\"wsParent\":{},\"lvl\":{},\"hp\":{:.2f},\"combat\":{},\"mounted\":{},\"cell\":",
            Finite(pos.x), Finite(pos.y), Finite(pos.z), Finite(player->GetAngleZ()),
            interior ? "true" : "false",
            world ? world->GetFormID() : 0,
            world && world->parentWorld ? world->parentWorld->GetFormID() : 0,
            player->GetLevel(), HealthPercent(player),
            player->IsInCombat() ? "true" : "false",
            player->IsOnMount() ? "true" : "false");
        AppendEscaped(json, cell->GetFullName());
        json += ",\"location\":";
        AppendEscaped(json, location ? location->GetFullName() : nullptr);
        json += ",\"game\":";
        AppendEscaped(json, std::string_view(g_gameDir));
        // So the relay can build the map for this setup (which MO2 instance, if any).
        json += ",\"mo2\":";
        AppendEscaped(json, std::string_view(g_mo2Dir));
        // Which interior / worldspace this is, so the map can load its local layout.
        json += ",\"cellKey\":";
        AppendEscaped(json, std::string_view(interior ? FormKey(cell) : std::string()));
        json += ",\"wsKey\":";
        AppendEscaped(json, std::string_view(world ? FormKey(world) : std::string()));
        json += '}';
        Relay::Send(json);
        g_costState.Add(start);

        if (includeActors) {
            start = Clock::now();
            SendActors(player);
            g_costActors.Add(start);
        }
        if (includeQuests) {
            start = Clock::now();
            SendGuarded(g_questPacket, player);
            SendGuarded(g_playerPacket, player);
            g_costQuests.Add(start);
        }
        if (includeSlow) {
            start = Clock::now();
            SendGuarded(g_discoveryPacket, player);
            SendGuarded(g_inventoryPacket, player);
            SendGuarded(g_magicPacket, player);
            g_costSlow.Add(start);
        }
        ReportCosts();
    }

    void WorkerLoop()
    {
        auto nextActors = std::chrono::steady_clock::now();
        auto nextQuests = nextActors;
        auto nextSlow = nextActors + std::chrono::milliseconds(500);  // offset from the quest tick

        while (g_running) {
            const auto now = std::chrono::steady_clock::now();
            const int actorHz = g_actorHz;
            const auto playerPeriod = std::chrono::milliseconds(1000 / std::max(1, g_playerHz.load()));
            const auto actorPeriod = std::chrono::milliseconds(1000 / std::max(1, actorHz));
            // Never stack tasks: if the game is busy (loading screen), skip this tick.
            if (!g_taskPending.exchange(true)) {
                const bool includeActors = actorHz > 0 && now >= nextActors;
                if (includeActors) {
                    nextActors = now + actorPeriod;
                }
                const bool includeQuests = now >= nextQuests;
                if (includeQuests) {
                    nextQuests = now + kQuestPeriod;
                }
                const bool includeSlow = now >= nextSlow;
                if (includeSlow) {
                    nextSlow = now + kSlowPeriod;
                }
                SKSE::GetTaskInterface()->AddTask([includeActors, includeQuests, includeSlow]() {
                    Collect(includeActors, includeQuests, includeSlow);
                    g_taskPending = false;
                });
            }
            std::this_thread::sleep_for(playerPeriod);
        }
    }
}

namespace Telemetry
{
    void Start(const Relay::Settings& settings)
    {
        if (g_running.exchange(true)) {
            return;
        }
        SetRates(settings.playerHz, settings.actorHz, settings.maxActors);
        g_gameDir = Relay::GameDirectory();
        g_mo2Dir = Relay::ModOrganizerDirectory();
        g_worker = std::thread(WorkerLoop);
    }

    void SetRates(int playerHz, int actorHz, int maxActors)
    {
        g_playerHz = std::clamp(playerHz, 1, 60);
        g_actorHz = std::clamp(actorHz, 0, 30);
        g_maxActors = std::clamp(maxActors, 0, 500);
    }

    Rates GetRates() { return { g_playerHz, g_actorHz, g_maxActors }; }

    void Stop()
    {
        if (g_running.exchange(false) && g_worker.joinable()) {
            g_worker.join();
        }
    }
}
