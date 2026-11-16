#include "Hotkeys.h"
#include "Ini.h"
#include "Menu.h"
#include "Relay.h"
#include "Telemetry.h"

#include <spdlog/sinks/basic_file_sink.h>

namespace
{
    void InitLogging()
    {
        auto dir = SKSE::log::log_directory();
        if (!dir) {
            return;
        }
        auto path = *dir / "SkyrimLiveMap.log";
        auto logger = std::make_shared<spdlog::logger>("global",
            std::make_shared<spdlog::sinks::basic_file_sink_mt>(path.string(), true));
        logger->set_level(spdlog::level::info);
        logger->flush_on(spdlog::level::info);
        spdlog::set_default_logger(std::move(logger));
    }

    void OnMessage(SKSE::MessagingInterface::Message* message)
    {
        if (message->type != SKSE::MessagingInterface::kDataLoaded) {
            return;
        }
        Hotkeys::Load();
        Hotkeys::Install();
        Menu::Register();

        const auto settings = Relay::LoadSettings(Ini::kPath);
        if (!Relay::Open(settings)) {
            SKSE::log::error("Could not open UDP socket to {}:{}", settings.host, settings.port);
            return;
        }
        SKSE::log::info("Streaming over {} (player {} Hz, actors {} Hz)", Relay::Describe(), settings.playerHz, settings.actorHz);
        Telemetry::Start(settings);
    }
}

SKSEPluginLoad(const SKSE::LoadInterface* skse)
{
    InitLogging();
    SKSE::Init(skse);
    SKSE::log::info("SkyrimLiveMap loaded");
    SKSE::GetMessagingInterface()->RegisterListener(OnMessage);
    return true;
}
