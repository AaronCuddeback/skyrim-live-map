#pragma once

#include <array>
#include <cstdint>
#include <optional>

// Keyboard shortcuts that drive the web map from inside the game (zoom, pan, recenter,
// 2D/3D, map style). Keys are DirectInput scan codes, like MCM hotkeys, stored in
// [Hotkeys] in SkyrimLiveMap.ini.
namespace Hotkeys
{
    struct Action
    {
        const char*   id;          // what the web map calls it
        const char*   label;       // shown in the in-game menu
        const char*   iniKey;
        std::uint32_t defaultKey;
        bool          continuous;  // acts while held (zoom, pan) rather than once per press
    };

    inline constexpr std::array kActions{
        Action{ "zoomIn", "Zoom in", "ZoomIn", 0x4E, true },              // Num +
        Action{ "zoomOut", "Zoom out", "ZoomOut", 0x4A, true },           // Num -
        Action{ "panUp", "Pan up", "PanUp", 0x48, true },                 // Num 8
        Action{ "panDown", "Pan down", "PanDown", 0x50, true },           // Num 2
        Action{ "panLeft", "Pan left", "PanLeft", 0x4B, true },           // Num 4
        Action{ "panRight", "Pan right", "PanRight", 0x4D, true },        // Num 6
        Action{ "follow", "Recenter on player", "Recenter", 0x4C, false },  // Num 5
        Action{ "view", "Switch 2D / 3D", "ToggleView", 0x52, false },    // Num 0
        Action{ "style", "Next map style", "NextStyle", 0x53, false },    // Num .
    };

    void Load();
    void Install();  // starts listening to the keyboard

    bool Enabled();
    void SetEnabled(bool enabled);
    std::uint32_t Key(std::size_t action);
    void SetKey(std::size_t action, std::uint32_t key);  // 0 clears it
    void ResetDefaults();

    // Rebinding: the next key pressed is assigned to the action. Escape cancels.
    void BeginCapture(std::size_t action);
    std::optional<std::size_t> Capturing();
    bool OfferCapture(std::uint32_t key);  // true if the key was taken for a rebind

    // One step of an action, as if its key were tapped (for the menu's buttons).
    void Tap(std::size_t action);

    const char* KeyName(std::uint32_t key);
}
