#pragma once

#include <string>

// Reads and writes SkyrimLiveMap.ini. Kept free of <windows.h> so it can be included
// next to CommonLib. Under MO2, writes land in the overwrite folder.
namespace Ini
{
    inline constexpr const char* kPath = "Data\\SKSE\\Plugins\\SkyrimLiveMap.ini";

    int GetInt(const char* section, const char* key, int fallback);
    void SetInt(const char* section, const char* key, int value);
}
