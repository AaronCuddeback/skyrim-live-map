#include "Player.h"

#include "Json.h"

#include <format>

namespace
{
    using Json::AppendEscaped;
    using Json::Finite;

    // "[current,max]"; max includes temporary boosts (fortify potions, enchantments).
    std::string Attribute(RE::Actor* actor, RE::ActorValue av)
    {
        auto* values = actor->AsActorValueOwner();
        const float max = values->GetPermanentActorValue(av) + actor->GetActorValueModifier(RE::ACTOR_VALUE_MODIFIERS::kTemporary, av);
        return std::format("[{:.0f},{:.0f}]", Finite(values->GetActorValue(av)), Finite(max));
    }

    const char* EquippedName(RE::Actor* actor, bool leftHand)
    {
        const auto* item = actor->GetEquippedObject(leftHand);
        return item ? item->GetName() : nullptr;
    }

    // Gold by scanning the inventory for the Gold001 item. Actor::GetGoldAmount() looks
    // gold up through BGSDefaultObjectManager, whose table differs between SE and AE;
    // in this multi-runtime CommonLib build that lookup crashes on SE 1.5.97.
    std::int32_t GoldCount(RE::PlayerCharacter* player)
    {
        constexpr RE::FormID kGold = 0x0000000F;
        const auto counts = player->GetInventoryCounts([](RE::TESBoundObject& item) { return item.GetFormID() == kGold; });
        std::int32_t total = 0;
        for (const auto& [item, count] : counts) {
            total += count;
        }
        return total;
    }

    float LevelProgress(RE::PlayerCharacter* player)
    {
        const auto* skills = player->GetInfoRuntimeData().skills;
        if (!skills || !skills->data || skills->data->levelThreshold <= 0.0f) {
            return 0.0f;
        }
        return std::clamp(skills->data->xp / skills->data->levelThreshold, 0.0f, 1.0f);
    }
}

namespace Player
{
    std::string Packet(RE::PlayerCharacter* player)
    {
        auto* values = player->AsActorValueOwner();
        const auto* state = player->AsActorState();

        std::string json = "{\"t\":\"player\",\"name\":";
        AppendEscaped(json, player->GetDisplayFullName());
        json += ",\"race\":";
        const auto* race = player->GetRace();
        AppendEscaped(json, race ? race->GetFullName() : nullptr);
        json += std::format(",\"lvl\":{},\"xp\":{:.3f},\"perks\":{},\"hp\":{},\"mp\":{},\"sp\":{},\"gold\":{},\"carry\":[{:.0f},{:.0f}],\"souls\":{:.0f},\"sneak\":{},\"drawn\":{},\"combat\":{},\"mounted\":{}",
            player->GetLevel(), Finite(LevelProgress(player)), player->GetGameStatsData().perkCount,
            Attribute(player, RE::ActorValue::kHealth), Attribute(player, RE::ActorValue::kMagicka), Attribute(player, RE::ActorValue::kStamina),
            GoldCount(player),
            Finite(values->GetActorValue(RE::ActorValue::kInventoryWeight)), Finite(values->GetActorValue(RE::ActorValue::kCarryWeight)),
            Finite(values->GetActorValue(RE::ActorValue::kDragonSouls)),
            player->IsSneaking() ? "true" : "false",
            state && state->IsWeaponDrawn() ? "true" : "false",
            player->IsInCombat() ? "true" : "false",
            player->IsOnMount() ? "true" : "false");
        json += ",\"right\":";
        AppendEscaped(json, EquippedName(player, false));
        json += ",\"left\":";
        AppendEscaped(json, EquippedName(player, true));

        char time[128]{};
        if (auto* calendar = RE::Calendar::GetSingleton()) {
            calendar->GetTimeDateString(time, sizeof(time), true);
        }
        json += ",\"time\":";
        AppendEscaped(json, static_cast<const char*>(time));
        json += '}';
        return json;
    }
}
