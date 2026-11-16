// SkyrimLiveMap.exe: starts the relay (app\server\server.js) with the bundled Node in this
// console window. Closing the window stops everything it started, map builders included.
#define WIN32_LEAN_AND_MEAN
#include <windows.h>

#include <conio.h>
#include <cstdio>
#include <string>

namespace
{
    std::wstring OwnDirectory()
    {
        std::wstring path(32768, L'\0');
        path.resize(GetModuleFileNameW(nullptr, path.data(), static_cast<DWORD>(path.size())));
        return path.substr(0, path.find_last_of(L"\\/"));
    }

    int Fail(const wchar_t* what)
    {
        wprintf(L"\n%s\nPress any key to close.\n", what);
        _getwch();
        return 1;
    }
}

int wmain()
{
    SetConsoleTitleW(L"Skyrim Live Map");
    SetConsoleOutputCP(CP_UTF8);  // Node writes UTF-8 (the QR code is block characters)

    const auto dir = OwnDirectory();
    const auto node = dir + L"\\runtime\\node\\node.exe";
    const auto server = dir + L"\\app\\server";
    if (GetFileAttributesW(node.c_str()) == INVALID_FILE_ATTRIBUTES || GetFileAttributesW((server + L"\\server.js").c_str()) == INVALID_FILE_ATTRIBUTES) {
        return Fail(L"Files are missing next to SkyrimLiveMap.exe. Extract the whole archive (keep the app and runtime folders beside it) and try again.");
    }

    // Everything started from here (Node, then Python map builders) is in this job, so it
    // all ends with the window, even if Node is killed first.
    const HANDLE job = CreateJobObjectW(nullptr, nullptr);
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    SetInformationJobObject(job, JobObjectExtendedLimitInformation, &limits, sizeof(limits));

    std::wstring command = L"\"" + node + L"\" server.js";
    STARTUPINFOW startup{ sizeof(startup) };
    PROCESS_INFORMATION process{};
    if (!CreateProcessW(node.c_str(), command.data(), nullptr, nullptr, FALSE, CREATE_SUSPENDED, nullptr, server.c_str(), &startup, &process)) {
        return Fail(L"Couldn't start the bundled Node.js. Your antivirus may have blocked runtime\\node\\node.exe.");
    }
    AssignProcessToJobObject(job, process.hProcess);
    ResumeThread(process.hThread);

    // Ctrl+C goes to Node too; wait for it to finish shutting down instead of dying first.
    SetConsoleCtrlHandler(nullptr, TRUE);
    WaitForSingleObject(process.hProcess, INFINITE);
    DWORD code = 0;
    GetExitCodeProcess(process.hProcess, &code);

    // Keep the window open on an error, so its message can be read.
    if (code != 0 && code != STATUS_CONTROL_C_EXIT && code != 130) {
        wprintf(L"\nSkyrim Live Map stopped (exit code %lu). Press any key to close.\n", code);
        _getwch();
    }
    return static_cast<int>(code);
}
