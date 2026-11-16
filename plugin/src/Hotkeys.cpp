#include "Hotkeys.h"

#include "Ini.h"
#include "Relay.h"

#include <format>

namespace
{
    constexpr auto kRepeat = std::chrono::milliseconds(250);  // the map releases a key after ~0.8 s without one
    constexpr std::uint32_t kEscape = 0x01;

    using Clock = std::chrono::steady_clock;

    std::atomic<bool> g_enabled{ true };
    std::array<std::atomic<std::uint32_t>, Hotkeys::kActions.size()> g_keys{};
    std::atomic<int> g_capturing{ -1 };

    // Main thread only (input events).
    std::array<bool, Hotkeys::kActions.size()> g_down{};
    std::array<Clock::time_point, Hotkeys::kActions.size()> g_lastSent{};

    void SendAction(std::size_t action, bool down, const char* extra = "")
    {
        Relay::Send(std::format("{{\"t\":\"input\",\"a\":\"{}\",\"s\":{}{}}}", Hotkeys::kActions[action].id, down ? 1 : 0, extra));
    }

    // Typing in the console, or sitting in a menu, shouldn't move the map.
    bool Blocked()
    {
        auto* ui = RE::UI::GetSingleton();
        return !ui || ui->GameIsPaused() || ui->IsMenuOpen(RE::Console::MENU_NAME);
    }

    void Release(std::size_t action)
    {
        if (g_down[action]) {
            g_down[action] = false;
            SendAction(action, false);
        }
    }

    class InputSink final : public RE::BSTEventSink<RE::InputEvent*>
    {
    public:
        RE::BSEventNotifyControl ProcessEvent(RE::InputEvent* const* events, RE::BSTEventSource<RE::InputEvent*>*) override
        {
            for (auto* event = events ? *events : nullptr; event; event = event->next) {
                if (event->GetEventType() != RE::INPUT_EVENT_TYPE::kButton || event->GetDevice() != RE::INPUT_DEVICE::kKeyboard) {
                    continue;
                }
                const auto* button = event->AsButtonEvent();
                const auto key = button->GetIDCode();
                if (button->IsDown() && Hotkeys::OfferCapture(key)) {
                    continue;
                }
                for (std::size_t i = 0; i < Hotkeys::kActions.size(); ++i) {
                    if (g_keys[i] != key) {
                        continue;
                    }
                    if (button->IsUp()) {
                        Release(i);
                    } else if (!g_enabled || Blocked()) {
                        Release(i);
                    } else if (button->IsDown()) {
                        g_down[i] = true;
                        g_lastSent[i] = Clock::now();
                        SendAction(i, true);
                    } else if (g_down[i] && Hotkeys::kActions[i].continuous && Clock::now() - g_lastSent[i] >= kRepeat) {
                        g_lastSent[i] = Clock::now();
                        SendAction(i, true, ",\"repeat\":true");
                    }
                }
            }
            return RE::BSEventNotifyControl::kContinue;
        }
    };
}

namespace Hotkeys
{
    void Load()
    {
        g_enabled = Ini::GetInt("Hotkeys", "Enabled", 1) != 0;
        for (std::size_t i = 0; i < kActions.size(); ++i) {
            g_keys[i] = static_cast<std::uint32_t>(std::clamp(Ini::GetInt("Hotkeys", kActions[i].iniKey, static_cast<int>(kActions[i].defaultKey)), 0, 0xFF));
        }
    }

    void Install()
    {
        static InputSink sink;
        if (auto* input = RE::BSInputDeviceManager::GetSingleton()) {
            input->AddEventSink(&sink);
        }
    }

    bool Enabled() { return g_enabled; }

    void SetEnabled(bool enabled)
    {
        g_enabled = enabled;
        Ini::SetInt("Hotkeys", "Enabled", enabled ? 1 : 0);
    }

    std::uint32_t Key(std::size_t action) { return g_keys[action]; }

    void SetKey(std::size_t action, std::uint32_t key)
    {
        // One key, one action: take it off any other action first.
        for (std::size_t i = 0; key && i < kActions.size(); ++i) {
            if (i != action && g_keys[i] == key) {
                g_keys[i] = 0;
                Ini::SetInt("Hotkeys", kActions[i].iniKey, 0);
            }
        }
        g_keys[action] = key;
        Ini::SetInt("Hotkeys", kActions[action].iniKey, static_cast<int>(key));
    }

    void ResetDefaults()
    {
        for (std::size_t i = 0; i < kActions.size(); ++i) {
            g_keys[i] = kActions[i].defaultKey;
            Ini::SetInt("Hotkeys", kActions[i].iniKey, static_cast<int>(kActions[i].defaultKey));
        }
    }

    void BeginCapture(std::size_t action) { g_capturing = static_cast<int>(action); }

    std::optional<std::size_t> Capturing()
    {
        const int action = g_capturing;
        return action >= 0 ? std::optional<std::size_t>(static_cast<std::size_t>(action)) : std::nullopt;
    }

    bool OfferCapture(std::uint32_t key)
    {
        const int action = g_capturing.exchange(-1);
        if (action < 0) {
            return false;
        }
        if (key != kEscape) {
            SetKey(static_cast<std::size_t>(action), key);
        }
        return true;
    }

    void Tap(std::size_t action)
    {
        SendAction(action, true, ",\"tap\":true");
    }

    const char* KeyName(std::uint32_t key)
    {
        static const std::unordered_map<std::uint32_t, const char*> names{
            { 0x01, "Esc" }, { 0x02, "1" }, { 0x03, "2" }, { 0x04, "3" }, { 0x05, "4" }, { 0x06, "5" }, { 0x07, "6" }, { 0x08, "7" },
            { 0x09, "8" }, { 0x0A, "9" }, { 0x0B, "0" }, { 0x0C, "-" }, { 0x0D, "=" }, { 0x0E, "Backspace" }, { 0x0F, "Tab" },
            { 0x10, "Q" }, { 0x11, "W" }, { 0x12, "E" }, { 0x13, "R" }, { 0x14, "T" }, { 0x15, "Y" }, { 0x16, "U" }, { 0x17, "I" },
            { 0x18, "O" }, { 0x19, "P" }, { 0x1A, "[" }, { 0x1B, "]" }, { 0x1C, "Enter" }, { 0x1D, "Left Ctrl" }, { 0x1E, "A" },
            { 0x1F, "S" }, { 0x20, "D" }, { 0x21, "F" }, { 0x22, "G" }, { 0x23, "H" }, { 0x24, "J" }, { 0x25, "K" }, { 0x26, "L" },
            { 0x27, ";" }, { 0x28, "'" }, { 0x29, "`" }, { 0x2A, "Left Shift" }, { 0x2B, "\\" }, { 0x2C, "Z" }, { 0x2D, "X" },
            { 0x2E, "C" }, { 0x2F, "V" }, { 0x30, "B" }, { 0x31, "N" }, { 0x32, "M" }, { 0x33, "," }, { 0x34, "." }, { 0x35, "/" },
            { 0x36, "Right Shift" }, { 0x37, "Num *" }, { 0x38, "Left Alt" }, { 0x39, "Space" }, { 0x3A, "Caps Lock" },
            { 0x3B, "F1" }, { 0x3C, "F2" }, { 0x3D, "F3" }, { 0x3E, "F4" }, { 0x3F, "F5" }, { 0x40, "F6" }, { 0x41, "F7" },
            { 0x42, "F8" }, { 0x43, "F9" }, { 0x44, "F10" }, { 0x45, "Num Lock" }, { 0x46, "Scroll Lock" }, { 0x47, "Num 7" },
            { 0x48, "Num 8" }, { 0x49, "Num 9" }, { 0x4A, "Num -" }, { 0x4B, "Num 4" }, { 0x4C, "Num 5" }, { 0x4D, "Num 6" },
            { 0x4E, "Num +" }, { 0x4F, "Num 1" }, { 0x50, "Num 2" }, { 0x51, "Num 3" }, { 0x52, "Num 0" }, { 0x53, "Num ." },
            { 0x57, "F11" }, { 0x58, "F12" }, { 0x9C, "Num Enter" }, { 0x9D, "Right Ctrl" }, { 0xB5, "Num /" }, { 0xB8, "Right Alt" },
            { 0xC7, "Home" }, { 0xC8, "Up" }, { 0xC9, "Page Up" }, { 0xCB, "Left" }, { 0xCD, "Right" }, { 0xCF, "End" },
            { 0xD0, "Down" }, { 0xD1, "Page Down" }, { 0xD2, "Insert" }, { 0xD3, "Delete" },
        };
        if (!key) {
            return "(none)";
        }
        const auto it = names.find(key);
        if (it != names.end()) {
            return it->second;
        }
        static thread_local std::string other;
        other = std::format("Key 0x{:02X}", key);
        return other.c_str();
    }
}
