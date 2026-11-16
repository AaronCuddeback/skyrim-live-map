#pragma once

#include <cmath>
#include <format>
#include <string>
#include <string_view>
#include <vector>

// Tiny helpers for the hand-built JSON packets.
namespace Json
{
    // JSON has no NaN/Infinity: one such value would make the relay reject the packet.
    inline float Finite(float value)
    {
        return std::isfinite(value) ? value : 0.0f;
    }

    inline void AppendEscaped(std::string& out, std::string_view text)
    {
        out += '"';
        for (const char c : text) {
            switch (c) {
            case '"':
                out += "\\\"";
                break;
            case '\\':
                out += "\\\\";
                break;
            default:
                if (static_cast<unsigned char>(c) >= 0x20) {
                    out += c;
                }
            }
        }
        out += '"';
    }

    // Game strings can be null (nameless actors, unnamed cells).
    inline void AppendEscaped(std::string& out, const char* text)
    {
        AppendEscaped(out, std::string_view(text ? text : ""));
    }

    // Split a list of JSON values into numbered packets that each stay a few KB:
    // {"t":type,"seq":n,"part":i,"parts":k,field:[...]} ; the map reassembles them.
    inline std::vector<std::string> Batches(std::string_view type, std::string_view field, const std::vector<std::string>& entries, std::size_t perPacket, std::uint32_t seq)
    {
        std::vector<std::string> packets;
        const std::size_t parts = std::max<std::size_t>(1, (entries.size() + perPacket - 1) / perPacket);
        for (std::size_t part = 0; part < parts; ++part) {
            std::string json = std::format("{{\"t\":\"{}\",\"seq\":{},\"part\":{},\"parts\":{},\"{}\":[", type, seq, part, parts, field);
            const std::size_t first = part * perPacket;
            const std::size_t last = std::min(entries.size(), first + perPacket);
            for (std::size_t i = first; i < last; ++i) {
                if (i > first) {
                    json += ',';
                }
                json += entries[i];
            }
            json += "]}";
            packets.push_back(std::move(json));
        }
        return packets;
    }
}
