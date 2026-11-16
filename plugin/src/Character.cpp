#include "Character.h"

#include "Json.h"

#include <format>
#include <unordered_set>

namespace
{
    using Json::AppendEscaped;
    using Json::Finite;

    constexpr std::size_t kPerPacket = 40;
    std::uint32_t g_inventorySeq = 0;
    std::uint32_t g_magicSeq = 0;

    const char* Category(RE::TESBoundObject* item)
    {
        switch (item->GetFormType()) {
        case RE::FormType::Weapon:
            return "weapon";
        case RE::FormType::Armor:
            return "apparel";
        case RE::FormType::Ammo:
            return "ammo";
        case RE::FormType::AlchemyItem:
            {
                const auto* potion = item->As<RE::AlchemyItem>();
                return potion->IsFood() ? "food" : potion->IsPoison() ? "poison" : "potion";
            }
        case RE::FormType::Ingredient:
            return "ingredient";
        case RE::FormType::Scroll:
            return "scroll";
        case RE::FormType::Book:
            return "book";
        case RE::FormType::SoulGem:
            return "soulgem";
        case RE::FormType::KeyMaster:
            return "key";
        default:
            return "misc";
        }
    }

    std::string School(RE::ActorValue skill)
    {
        switch (skill) {
        case RE::ActorValue::kAlteration:
            return "alteration";
        case RE::ActorValue::kConjuration:
            return "conjuration";
        case RE::ActorValue::kDestruction:
            return "destruction";
        case RE::ActorValue::kIllusion:
            return "illusion";
        case RE::ActorValue::kRestoration:
            return "restoration";
        default:
            return "other";
        }
    }

    // "Fire Damage · 25 pts · 5 s"-style summary of a spell's main effect.
    std::string MainEffect(RE::MagicItem* spell)
    {
        const auto* effect = spell->GetCostliestEffectItem();
        if (!effect || !effect->baseEffect) {
            return {};
        }
        std::string text = effect->baseEffect->GetFullName();
        if (effect->effectItem.magnitude > 0.0f) {
            text += std::format(" · {:.0f} pts", effect->effectItem.magnitude);
        }
        if (effect->effectItem.duration > 0) {
            text += std::format(" · {} s", effect->effectItem.duration);
        }
        return text;
    }

    void Collect(RE::TESSpellList::SpellData* list, std::vector<RE::SpellItem*>& spells, std::vector<RE::TESShout*>& shouts)
    {
        if (!list) {
            return;
        }
        for (std::uint32_t i = 0; list->spells && i < list->numSpells; ++i) {
            spells.push_back(list->spells[i]);
        }
        for (std::uint32_t i = 0; list->shouts && i < list->numShouts; ++i) {
            shouts.push_back(list->shouts[i]);
        }
    }
}

namespace Character
{
    std::vector<std::string> InventoryPackets(RE::PlayerCharacter* player)
    {
        std::vector<std::string> entries;
        for (auto& [item, data] : player->GetInventory()) {
            const auto& [count, entry] = data;
            if (!item || count <= 0 || !item->GetPlayable()) {
                continue;
            }
            const char* name = entry ? entry->GetDisplayName() : nullptr;
            if (!name || !*name) {
                name = item->GetName();
            }
            if (!name || !*name) {
                continue;  // unnamed technical items
            }
            float damage = 0.0f, armor = 0.0f;
            if (const auto* weapon = item->As<RE::TESObjectWEAP>()) {
                damage = static_cast<float>(weapon->attackDamage);
            } else if (const auto* apparel = item->As<RE::TESObjectARMO>()) {
                armor = static_cast<float>(apparel->armorRating) / 100.0f;
            }
            std::string json = "{\"n\":";
            AppendEscaped(json, name);
            json += std::format(",\"k\":\"{}\",\"c\":{},\"w\":{:.2f},\"v\":{},\"d\":{:.0f},\"a\":{:.0f},\"e\":{},\"f\":{},\"x\":{},\"q\":{}}}",
                Category(item), count, Finite(entry ? entry->GetWeight() : 0.0f), entry ? entry->GetValue() : 0, Finite(damage), Finite(armor),
                entry && entry->IsWorn() ? 1 : 0, entry && entry->IsFavorited() ? 1 : 0, entry && entry->IsEnchanted() ? 1 : 0, entry && entry->IsQuestObject() ? 1 : 0);
            entries.push_back(std::move(json));
        }
        return Json::Batches("inventory", "items", entries, kPerPacket, ++g_inventorySeq);
    }

    std::vector<std::string> MagicPackets(RE::PlayerCharacter* player)
    {
        // Spells come from the character, their race and everything learned in play.
        std::vector<RE::SpellItem*> spells;
        std::vector<RE::TESShout*>  shouts;
        if (auto* base = player->GetActorBase()) {
            Collect(base->actorEffects, spells, shouts);
        }
        if (auto* race = player->GetRace()) {
            Collect(race->actorEffects, spells, shouts);
        }
        auto& runtime = player->GetActorRuntimeData();
        for (auto* spell : runtime.addedSpells) {
            spells.push_back(spell);
        }
        const auto* left = runtime.selectedSpells[RE::Actor::SlotTypes::kLeftHand];
        const auto* right = runtime.selectedSpells[RE::Actor::SlotTypes::kRightHand];
        const auto* power = runtime.selectedPower;

        std::vector<std::string> entries;
        std::unordered_set<RE::FormID> seen;
        for (auto* spell : spells) {
            if (!spell || !seen.insert(spell->GetFormID()).second) {
                continue;
            }
            const auto type = spell->GetSpellType();
            std::string kind;
            if (type == RE::MagicSystem::SpellType::kSpell) {
                kind = School(spell->GetAssociatedSkill());
            } else if (type == RE::MagicSystem::SpellType::kPower || type == RE::MagicSystem::SpellType::kLesserPower) {
                kind = "power";
            } else {
                continue;  // abilities, diseases etc. are passive or hidden
            }
            const char* name = spell->GetFullName();
            if (!name || !*name) {
                continue;
            }
            const char* equipped = spell == left && spell == right ? "both" : spell == left ? "left" : spell == right ? "right" : spell == power ? "power" : "";
            std::string json = "{\"n\":";
            AppendEscaped(json, name);
            json += std::format(",\"k\":\"{}\",\"c\":{:.0f},\"eq\":\"{}\",\"fx\":", kind, Finite(kind == "power" ? 0.0f : spell->CalculateMagickaCost(player)), equipped);
            AppendEscaped(json, std::string_view(MainEffect(spell)));
            json += '}';
            entries.push_back(std::move(json));
        }
        for (auto* shout : shouts) {
            if (!shout || !seen.insert(shout->GetFormID()).second) {
                continue;
            }
            const char* name = shout->GetFullName();
            if (!name || !*name) {
                continue;
            }
            std::string json = "{\"n\":";
            AppendEscaped(json, name);
            json += std::format(",\"k\":\"shout\",\"c\":0,\"eq\":\"{}\",\"fx\":\"\"}}", shout == power ? "power" : "");
            entries.push_back(std::move(json));
        }
        return Json::Batches("magic", "spells", entries, kPerPacket, ++g_magicSeq);
    }
}
