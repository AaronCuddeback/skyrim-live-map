#include "Discovery.h"

#include "FormKey.h"
#include "Json.h"

#include <format>

namespace
{
    constexpr RE::FormID kMapMarker = 0x00000010;
    constexpr std::size_t kIdsPerPacket = 150;

    struct Marker
    {
        RE::TESObjectREFR* ref;
        std::string        id;  // quoted JSON string, ready to append
    };

    std::vector<Marker> g_markers;
    bool                g_scanned = false;
    std::uint32_t       g_seq = 0;

    // Map markers are persistent references, so they're all in memory once the game
    // data is loaded. Find them once; their discovered flags are read on every packet.
    void Scan()
    {
        g_scanned = true;
        const auto& [forms, lock] = RE::TESForm::GetAllForms();
        RE::BSReadLockGuard guard(lock);
        if (!forms) {
            return;
        }
        for (const auto& [formID, form] : *forms) {
            if (!form || form->GetFormType() != RE::FormType::Reference) {
                continue;
            }
            auto* ref = form->As<RE::TESObjectREFR>();
            const auto* base = ref ? ref->GetBaseObject() : nullptr;
            if (!base || base->GetFormID() != kMapMarker || !ref->extraList.HasType<RE::ExtraMapMarker>()) {
                continue;
            }
            std::string id;
            Json::AppendEscaped(id, std::string_view(FormKey(ref)));
            g_markers.push_back({ ref, std::move(id) });
        }
        SKSE::log::info("Found {} world map markers", g_markers.size());
    }
}

namespace Discovery
{
    std::vector<std::string> Packets(RE::PlayerCharacter*)
    {
        if (!g_scanned) {
            Scan();
        }
        // Discovered and heard-of markers go in separate lists of each packet.
        std::vector<std::string> discovered, known;
        for (const auto& marker : g_markers) {
            const auto* extra = marker.ref->extraList.GetByType<RE::ExtraMapMarker>();
            const auto* data = extra ? extra->mapData : nullptr;
            if (!data) {
                continue;
            }
            if (data->flags.all(RE::MapMarkerData::Flag::kCanTravelTo)) {
                discovered.push_back(marker.id);
            } else if (data->flags.all(RE::MapMarkerData::Flag::kVisible)) {
                known.push_back(marker.id);
            }
        }

        const auto seq = ++g_seq;
        const std::size_t total = discovered.size() + known.size();
        const std::size_t parts = std::max<std::size_t>(1, (total + kIdsPerPacket - 1) / kIdsPerPacket);
        std::vector<std::string> packets;
        std::size_t d = 0, k = 0;
        for (std::size_t part = 0; part < parts; ++part) {
            std::string json = std::format("{{\"t\":\"discovered\",\"seq\":{},\"part\":{},\"parts\":{},\"discovered\":[", seq, part, parts);
            std::size_t room = kIdsPerPacket;
            for (bool first = true; room && d < discovered.size(); --room, first = false) {
                if (!first) {
                    json += ',';
                }
                json += discovered[d++];
            }
            json += "],\"known\":[";
            for (bool first = true; room && k < known.size(); --room, first = false) {
                if (!first) {
                    json += ',';
                }
                json += known[k++];
            }
            json += "]}";
            packets.push_back(std::move(json));
        }
        return packets;
    }
}
