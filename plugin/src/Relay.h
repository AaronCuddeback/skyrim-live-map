#pragma once

#include <string>
#include <string_view>

// Kept free of <windows.h>/<winsock2.h> so it can be included next to CommonLib.
namespace Relay
{
    struct Settings
    {
        // "pipe": a local named pipe to a relay on this PC. Not network traffic, so
        // ReShade's multiplayer guard leaves add-ons (DLSS etc.) alone.
        // "udp": packets to Host:Port, for a relay running on another computer.
        std::string transport = "pipe";
        std::string pipeName = "SkyrimLiveMap";
        std::string host = "127.0.0.1";
        int port = 27015;
        int playerHz = 10;
        int actorHz = 2;
        int maxActors = 120;
    };

    Settings LoadSettings(const std::string& iniPath);
    bool Open(const Settings& settings);
    // Queues the packet; a background thread delivers it, so the game never waits.
    void Send(std::string_view payload);
    std::string Describe();
    // e.g. "relay connected" or "waiting for the relay to connect", for the log.
    std::string Status();

    // Folder of the running SkyrimSE.exe (UTF-8), e.g. a modlist's "Stock Game".
    // Lets the map pick the matching modlist's data.
    std::string GameDirectory();
    // Where the Mod Organizer 2 that launched the game lives, or "" if it wasn't MO2.
    std::string ModOrganizerDirectory();
}
