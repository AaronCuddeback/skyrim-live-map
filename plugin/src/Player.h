#pragma once

namespace Player
{
    // JSON packet with the player's stats for the map's character card: attributes,
    // level progress, gold, carry weight, equipped items, status and game time.
    // Must run on the game's main thread.
    std::string Packet(RE::PlayerCharacter* player);
}
