// Compiled without the PCH: needs <windows.h>.
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>

#include "Ini.h"

namespace Ini
{
    int GetInt(const char* section, const char* key, int fallback)
    {
        return static_cast<int>(GetPrivateProfileIntA(section, key, fallback, kPath));
    }

    void SetInt(const char* section, const char* key, int value)
    {
        WritePrivateProfileStringA(section, key, std::to_string(value).c_str(), kPath);
    }
}
