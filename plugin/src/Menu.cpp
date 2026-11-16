#include "Menu.h"

#include "Hotkeys.h"
#include "Ini.h"
#include "Relay.h"
#include "Telemetry.h"

#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#pragma warning(push)
#pragma warning(disable : 4996 4099 5054)  // third-party header
#include "vendor/SKSEMenuFramework.h"
#pragma warning(pop)

namespace
{
    namespace ImGui = ImGuiMCP;

    const ImGui::ImVec4 kGold{ 0.91f, 0.81f, 0.56f, 1.0f };
    const ImGui::ImVec4 kGreen{ 0.33f, 0.78f, 0.46f, 1.0f };
    const ImGui::ImVec4 kAmber{ 0.89f, 0.81f, 0.55f, 1.0f };

    void ActionButton(const char* label, const char* id)
    {
        for (std::size_t i = 0; i < Hotkeys::kActions.size(); ++i) {
            if (std::string_view(Hotkeys::kActions[i].id) == id) {
                if (ImGui::Button(label)) {
                    Hotkeys::Tap(i);
                }
                return;
            }
        }
    }

    void RenderConnection()
    {
        ImGui::SeparatorText("Connection");
        const auto status = Relay::Status();
        const bool connected = status == "relay connected" || status == "sending UDP";
        ImGui::TextColored(connected ? kGreen : kAmber, "Relay: %s", status.c_str());
        ImGui::TextWrapped("Open the map in a browser at http://<this PC's address>:8787. The relay window prints the address and a QR code for your phone.");
    }

    void RenderControls()
    {
        ImGui::SeparatorText("Map controls");
        ImGui::TextDisabled("Moves the map on every screen that has it open.");
        ActionButton("Zoom in", "zoomIn");
        ImGui::SameLine();
        ActionButton("Zoom out", "zoomOut");
        ImGui::SameLine();
        ActionButton("Recenter", "follow");
        ImGui::SameLine();
        ActionButton("2D / 3D", "view");
        ImGui::SameLine();
        ActionButton("Map style", "style");
    }

    void RenderHotkeys()
    {
        ImGui::SeparatorText("Hotkeys");
        bool enabled = Hotkeys::Enabled();
        if (ImGui::Checkbox("Enable hotkeys", &enabled)) {
            Hotkeys::SetEnabled(enabled);
        }
        ImGui::TextDisabled("They work while you play; menus and the console ignore them. Hold zoom and pan keys.");

        const auto capturing = Hotkeys::Capturing();
        if (ImGui::BeginTable("hotkeys##SkyrimLiveMap", 3, ImGui::ImGuiTableFlags_RowBg | ImGui::ImGuiTableFlags_SizingStretchProp)) {
            ImGui::TableSetupColumn("Action", 0, 2.0f);
            ImGui::TableSetupColumn("Key", 0, 1.6f);
            ImGui::TableSetupColumn("", 0, 1.6f);
            ImGui::TableHeadersRow();
            for (std::size_t i = 0; i < Hotkeys::kActions.size(); ++i) {
                ImGui::PushID(static_cast<int>(i));
                ImGui::TableNextRow();
                ImGui::TableSetColumnIndex(0);
                ImGui::Text("%s", Hotkeys::kActions[i].label);
                ImGui::TableSetColumnIndex(1);
                if (capturing == i) {
                    ImGui::TextColored(kGold, "Press a key... (Esc cancels)");
                } else {
                    ImGui::Text("%s", Hotkeys::KeyName(Hotkeys::Key(i)));
                }
                ImGui::TableSetColumnIndex(2);
                if (ImGui::Button("Change")) {
                    Hotkeys::BeginCapture(i);
                }
                ImGui::SameLine();
                if (ImGui::Button("Clear")) {
                    Hotkeys::SetKey(i, 0);
                }
                ImGui::PopID();
            }
            ImGui::EndTable();
        }
        if (ImGui::Button("Reset keys to defaults (number pad)")) {
            Hotkeys::ResetDefaults();
        }
    }

    void RenderRates()
    {
        ImGui::SeparatorText("Updates");
        auto rates = Telemetry::GetRates();
        bool changed = false;
        changed |= ImGui::SliderInt("Player updates per second", &rates.playerHz, 1, 30);
        changed |= ImGui::SliderInt("Creature and NPC updates per second", &rates.actorHz, 0, 10);
        changed |= ImGui::SliderInt("Most creatures and NPCs sent", &rates.maxActors, 0, 300);
        if (changed) {
            Telemetry::SetRates(rates.playerHz, rates.actorHz, rates.maxActors);
            Ini::SetInt("Telemetry", "PlayerHz", rates.playerHz);
            Ini::SetInt("Telemetry", "ActorHz", rates.actorHz);
            Ini::SetInt("Telemetry", "MaxActors", rates.maxActors);
        }
        ImGui::TextDisabled("0 creature updates turns tracking off. Changes are saved to SkyrimLiveMap.ini (in MO2's overwrite folder).");
    }

    void __stdcall Render()
    {
        RenderConnection();
        ImGui::Spacing();
        RenderControls();
        ImGui::Spacing();
        RenderHotkeys();
        ImGui::Spacing();
        RenderRates();
    }

    // While the menu is open the framework holds the keyboard, so rebinding listens here.
    bool __stdcall OnInput(RE::InputEvent* event)
    {
        if (!event || event->GetEventType() != RE::INPUT_EVENT_TYPE::kButton || event->GetDevice() != RE::INPUT_DEVICE::kKeyboard) {
            return false;
        }
        const auto* button = event->AsButtonEvent();
        return button->IsDown() && Hotkeys::OfferCapture(button->GetIDCode());
    }
}

namespace Menu
{
    void Register()
    {
        if (!GetMenuFrameworkModule()) {
            SKSE::log::info("SKSE Menu Framework not found; settings are in SkyrimLiveMap.ini");
            return;
        }
        SKSEMenuFramework::SetSection("Skyrim Live Map");
        SKSEMenuFramework::AddSectionItem("Settings", Render);
        SKSEMenuFramework::AddInputEvent(OnInput);
        SKSE::log::info("Added the Skyrim Live Map page to SKSE Menu Framework");
    }
}
