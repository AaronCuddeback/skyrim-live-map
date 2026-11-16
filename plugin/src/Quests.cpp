#include "Quests.h"

#include "Json.h"

#include <format>
#include <optional>

namespace
{
    using Json::AppendEscaped;
    using Json::Finite;

    constexpr RE::FormID kTamriel = 0x3C;

    // Tamriel, or a walled-city worldspace inside it (same coordinates).
    bool OnMap(const RE::TESWorldSpace* world)
    {
        return world && (world->GetFormID() == kTamriel || (world->parentWorld && world->parentWorld->GetFormID() == kTamriel));
    }

    bool OnMapExterior(RE::TESObjectREFR* ref)
    {
        const auto* cell = ref->GetParentCell();
        return cell && !cell->IsInteriorCell() && OnMap(ref->GetWorldspace());
    }

    RE::NiPointer<RE::TESObjectREFR> AliasReference(RE::TESQuest* quest, std::uint32_t aliasID)
    {
        RE::ObjectRefHandle handle;
        quest->CreateRefHandleByAliasID(handle, aliasID);
        return handle.get();
    }

    struct Pin
    {
        RE::NiPoint3 pos;
        const char*  inside = nullptr;  // location name when the target is indoors
    };

    // Where to pin a target on the world map: the reference itself when it's outdoors,
    // otherwise the map marker of the location containing it (a dungeon's entrance),
    // walking up parent locations until one is on the map, like the in-game map does.
    std::optional<Pin> Locate(RE::TESObjectREFR* ref)
    {
        if (OnMapExterior(ref)) {
            return Pin{ ref->GetPosition() };
        }
        auto* location = ref->GetCurrentLocation();
        if (!location && ref->GetParentCell()) {
            location = ref->GetParentCell()->GetLocation();
        }
        if (!location) {
            location = ref->GetEditorLocation();
        }
        for (int depth = 0; location && depth < 8; ++depth, location = location->parentLoc) {
            const auto marker = location->worldLocMarker.get();
            if (marker && OnMapExterior(marker.get())) {
                return Pin{ marker->GetPosition(), location->GetFullName() };
            }
        }
        return std::nullopt;
    }

    bool SameText(std::string_view a, std::string_view b)
    {
        return a.size() == b.size() && std::equal(a.begin(), a.end(), b.begin(), [](char x, char y) {
            return std::tolower(static_cast<unsigned char>(x)) == std::tolower(static_cast<unsigned char>(y));
        });
    }

    std::string AliasName(RE::TESQuest* quest, std::string_view aliasName)
    {
        for (auto* alias : quest->aliases) {
            if (alias && SameText(alias->aliasName.c_str(), aliasName)) {
                if (const auto ref = AliasReference(quest, alias->aliasID)) {
                    const char* name = ref->GetDisplayFullName();
                    if (name && *name) {
                        return name;
                    }
                }
                break;
            }
        }
        return std::string(aliasName);
    }

    // Objective text with <Alias=Name> / <Alias.ShortName=Name> tokens filled in,
    // as the journal shows them ("Retrieve the Golden Claw for Lucan Valerius").
    std::string ObjectiveText(RE::TESQuest* quest, const RE::BGSQuestObjective* objective)
    {
        const std::string text = objective->displayText.c_str();
        std::string out;
        std::size_t pos = 0;
        while (pos < text.size()) {
            const auto open = text.find('<', pos);
            const auto close = open == std::string::npos ? std::string::npos : text.find('>', open);
            if (close == std::string::npos) {
                out += text.substr(pos);
                break;
            }
            out += text.substr(pos, open - pos);
            const std::string_view token(text.data() + open + 1, close - open - 1);
            const auto eq = token.find('=');
            out += AliasName(quest, eq == std::string_view::npos ? token : token.substr(eq + 1));
            pos = close + 1;
        }
        return out;
    }

    const RE::BGSQuestObjective* OwnerObjective(RE::TESQuest* quest, const RE::TESQuestTarget* target)
    {
        for (const auto* objective : quest->objectives) {
            for (std::uint32_t i = 0; objective && i < objective->numTargets; ++i) {
                if (objective->targets[i] == target) {
                    return objective;
                }
            }
        }
        return nullptr;
    }

    void AppendQuest(std::string& json, RE::TESQuest* quest, const RE::BSTArray<RE::TESQuestTarget*>* targets)
    {
        json += std::format("{{\"id\":{},\"name\":", quest->GetFormID());
        AppendEscaped(json, quest->GetFullName());

        // Objectives currently shown in the journal for this quest.
        json += ",\"objectives\":[";
        bool first = true;
        for (const auto* objective : quest->objectives) {
            if (objective && objective->state == RE::QUEST_OBJECTIVE_STATE::kDisplayed) {
                if (!first) {
                    json += ',';
                }
                first = false;
                AppendEscaped(json, ObjectiveText(quest, objective));
            }
        }

        // Targets the game is currently pointing the compass at.
        json += "],\"targets\":[";
        first = true;
        for (const auto* target : targets ? *targets : RE::BSTArray<RE::TESQuestTarget*>{}) {
            if (!target) {
                continue;
            }
            const auto ref = AliasReference(quest, target->alias);
            const auto pin = ref ? Locate(ref.get()) : std::nullopt;
            if (!pin) {
                continue;
            }
            if (!first) {
                json += ',';
            }
            first = false;
            const auto* objective = OwnerObjective(quest, target);
            json += std::format("{{\"x\":{:.0f},\"y\":{:.0f},\"z\":{:.0f},\"text\":", Finite(pin->pos.x), Finite(pin->pos.y), Finite(pin->pos.z));
            AppendEscaped(json, objective ? ObjectiveText(quest, objective) : std::string());
            json += ",\"inside\":";
            AppendEscaped(json, pin->inside);
            json += '}';
        }
        json += "]}";
    }
}

namespace Quests
{
    std::string Packet(RE::PlayerCharacter* player)
    {
        std::string json = "{\"t\":\"quests\",\"quests\":[";
        if (REL::Module::IsVR()) {
            return json + "]}";
        }
        // CommonLib hides these PLAYER_RUNTIME_DATA fields when built for SE+AE+VR at
        // once. Its non-VR layout (shared by SE and AE) puts questTargetsLock at the
        // block's start and questTargets 0x1C0 in (SE offsets 0x3D8 / 0x598);
        // GetPlayerRuntimeData() already resolves where the block starts per runtime.
        using QuestTargetMap = RE::BSTHashMap<RE::TESQuest*, RE::BSTArray<RE::TESQuestTarget*>*>;
        auto* block = reinterpret_cast<std::uint8_t*>(&player->GetPlayerRuntimeData());
        auto& questTargetsLock = *reinterpret_cast<RE::BSSpinLock*>(block);
        auto& questTargets = *reinterpret_cast<QuestTargetMap*>(block + 0x1C0);

        bool first = true;
        RE::BSSpinLockGuard guard(questTargetsLock);
        for (auto& [quest, targets] : questTargets) {
            // IsActive() = the player has the quest selected in the journal.
            if (!quest || !quest->IsActive()) {
                continue;
            }
            if (!first) {
                json += ',';
            }
            first = false;
            AppendQuest(json, quest, targets);
        }
        json += "]}";
        return json;
    }
}
