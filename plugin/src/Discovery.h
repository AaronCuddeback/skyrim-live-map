#pragma once

namespace Discovery
{
    // Packets listing which world map markers the player has discovered (can fast
    // travel to) and which they've only heard of. Marker ids match the map data:
    // "plugin.esp:LOCALID". Must run on the game's main thread.
    std::vector<std::string> Packets(RE::PlayerCharacter* player);
}
