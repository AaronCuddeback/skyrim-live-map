#pragma once

namespace Character
{
    // Batched packets with the player's inventory: name, category, count, weight,
    // value, base damage/armor and equipped/favorite/enchanted/quest flags.
    std::vector<std::string> InventoryPackets(RE::PlayerCharacter* player);

    // Batched packets with the player's spells, powers and shouts: school, magicka
    // cost, main effect and what's equipped. Must run on the game's main thread.
    std::vector<std::string> MagicPackets(RE::PlayerCharacter* player);
}
