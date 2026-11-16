#pragma once

namespace Quests
{
    // JSON packet with the quests the player is tracking (active in the journal), their
    // current objectives, and where each objective's target sits on the world map.
    // Must run on the game's main thread.
    std::string Packet(RE::PlayerCharacter* player);
}
