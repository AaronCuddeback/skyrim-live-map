#pragma once

#include <format>
#include <string>

// "plugin.esp:01ABCD": the plugin that defines a form plus its id within that plugin.
// The map extractor names cells, worldspaces and map markers the same way, so this is
// how the map matches what the game reports to its own data.
inline std::string FormKey(const RE::TESForm* form)
{
    const auto* file = form ? form->GetFile(0) : nullptr;
    if (!file) {
        return {};
    }
    std::string name(file->GetFilename());
    std::transform(name.begin(), name.end(), name.begin(), [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
    const auto local = form->GetFormID() & (file->IsLight() ? 0xFFFu : 0xFFFFFFu);
    return std::format("{}:{:06X}", name, local);
}
