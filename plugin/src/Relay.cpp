// Compiled without the PCH: this is the only file that sees Winsock.
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>
#include <sddl.h>

#include "Relay.h"

#include <algorithm>
#include <chrono>
#include <condition_variable>
#include <cstdint>
#include <deque>
#include <format>
#include <iterator>
#include <mutex>
#include <string>
#include <thread>

namespace
{
    // About 10 seconds of traffic; past that the relay is gone or stuck, so drop the oldest.
    constexpr std::size_t kMaxQueued = 256;

    Relay::Settings g_settings;
    std::mutex g_lock;
    std::condition_variable g_wake;
    std::deque<std::string> g_queue;

    SOCKET g_socket = INVALID_SOCKET;
    sockaddr_in g_target{};

    HANDLE g_pipe = INVALID_HANDLE_VALUE;
    std::wstring g_pipePath;
    std::mutex g_statusLock;
    std::string g_status = "starting";

    int ReadInt(const char* section, const char* key, int fallback, const std::string& ini)
    {
        return static_cast<int>(GetPrivateProfileIntA(section, key, fallback, ini.c_str()));
    }

    std::string ReadString(const char* section, const char* key, const std::string& fallback, const std::string& ini)
    {
        char value[256]{};
        GetPrivateProfileStringA(section, key, fallback.c_str(), value, sizeof(value), ini.c_str());
        return value;
    }

    bool OpenUdp()
    {
        WSADATA wsa{};
        if (WSAStartup(MAKEWORD(2, 2), &wsa) != 0) {
            return false;
        }
        g_socket = socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP);
        if (g_socket == INVALID_SOCKET) {
            return false;
        }
        g_target.sin_family = AF_INET;
        g_target.sin_port = htons(static_cast<u_short>(g_settings.port));
        return inet_pton(AF_INET, g_settings.host.c_str(), &g_target.sin_addr) == 1;
    }

    void SendUdp(const std::string& payload)
    {
        // Fire and forget: if the relay isn't running, packets are simply dropped.
        sendto(g_socket, payload.data(), static_cast<int>(payload.size()), 0,
            reinterpret_cast<const sockaddr*>(&g_target), sizeof(g_target));
    }

    void SetStatus(std::string status)
    {
        std::lock_guard lock(g_statusLock);
        g_status = std::move(status);
    }

    std::string Pop()
    {
        std::unique_lock lock(g_lock);
        g_wake.wait(lock, [] { return !g_queue.empty(); });
        std::string payload = std::move(g_queue.front());
        g_queue.pop_front();
        return payload;
    }

    // The game hosts the pipe and the relay connects to it. The pipe's permissions
    // admit this Windows account at any privilege level: a relay started from an
    // administrator terminal can still connect to a game that isn't elevated, and the
    // other way round. (Windows blocks that when the relay hosts the pipe.)
    bool CreatePipe()
    {
        std::wstring user;
        HANDLE token = nullptr;
        if (OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token)) {
            alignas(TOKEN_USER) std::uint8_t buffer[256]{};
            DWORD size = 0;
            wchar_t* sid = nullptr;
            if (GetTokenInformation(token, TokenUser, buffer, sizeof(buffer), &size) &&
                ConvertSidToStringSidW(reinterpret_cast<TOKEN_USER*>(buffer)->User.Sid, &sid)) {
                user = sid;
                LocalFree(sid);
            }
            CloseHandle(token);
        }
        // SYSTEM, administrators and this user; low mandatory label = any integrity level.
        const std::wstring sddl = L"D:P(A;;GA;;;SY)(A;;GA;;;BA)" + (user.empty() ? L"(A;;GA;;;IU)" : L"(A;;GA;;;" + user + L")") + L"S:(ML;;NW;;;LW)";
        PSECURITY_DESCRIPTOR descriptor = nullptr;
        if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl.c_str(), SDDL_REVISION_1, &descriptor, nullptr)) {
            descriptor = nullptr;  // fall back to default permissions
        }
        SECURITY_ATTRIBUTES attributes{ sizeof(attributes), descriptor, FALSE };
        g_pipe = CreateNamedPipeW(g_pipePath.c_str(), PIPE_ACCESS_DUPLEX | FILE_FLAG_FIRST_PIPE_INSTANCE,
            PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
            1, 1 << 20, 4096, 0, descriptor ? &attributes : nullptr);
        const DWORD error = GetLastError();
        if (descriptor) {
            LocalFree(descriptor);
        }
        if (g_pipe == INVALID_HANDLE_VALUE) {
            SetStatus(std::format("could not create the pipe (error {}); is a relay from 0.7.1/0.7.2 still running? Restart it with the current server", error));
            return false;
        }
        return true;
    }

    bool WriteFrame(const std::string& payload)
    {
        // Byte stream, so each packet goes out as a 4-byte little-endian length + JSON.
        std::string frame(4, '\0');
        const auto size = static_cast<std::uint32_t>(payload.size());
        for (int i = 0; i < 4; ++i) {
            frame[i] = static_cast<char>((size >> (8 * i)) & 0xFF);
        }
        frame += payload;
        DWORD written = 0;
        return WriteFile(g_pipe, frame.data(), static_cast<DWORD>(frame.size()), &written, nullptr) && written == frame.size();
    }

    void PipeLoop()
    {
        for (;;) {
            if (!CreatePipe()) {
                std::this_thread::sleep_for(std::chrono::seconds(2));
                continue;
            }
            SetStatus("waiting for the relay to connect");
            // Blocks this thread (never the game) until the relay connects.
            if (ConnectNamedPipe(g_pipe, nullptr) || GetLastError() == ERROR_PIPE_CONNECTED) {
                {
                    std::lock_guard lock(g_lock);
                    g_queue.clear();  // drop what piled up while nobody was listening
                }
                SetStatus("relay connected");
                while (WriteFrame(Pop())) {
                }
                SetStatus("relay disconnected; waiting for it to reconnect");
            }
            DisconnectNamedPipe(g_pipe);
            CloseHandle(g_pipe);
            g_pipe = INVALID_HANDLE_VALUE;
        }
    }

    void UdpLoop()
    {
        for (;;) {
            SendUdp(Pop());
        }
    }

    std::wstring Widen(const std::string& text)
    {
        const int size = MultiByteToWideChar(CP_UTF8, 0, text.c_str(), static_cast<int>(text.size()), nullptr, 0);
        std::wstring wide(static_cast<std::size_t>(size), L'\0');
        MultiByteToWideChar(CP_UTF8, 0, text.c_str(), static_cast<int>(text.size()), wide.data(), size);
        return wide;
    }
}

namespace Relay
{
    Settings LoadSettings(const std::string& iniPath)
    {
        Settings s;
        s.transport = ReadString("Relay", "Transport", s.transport, iniPath);
        std::transform(s.transport.begin(), s.transport.end(), s.transport.begin(),
            [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
        s.pipeName = ReadString("Relay", "PipeName", s.pipeName, iniPath);
        s.host = ReadString("Relay", "Host", s.host, iniPath);
        s.port = ReadInt("Relay", "Port", s.port, iniPath);
        s.playerHz = std::clamp(ReadInt("Telemetry", "PlayerHz", s.playerHz, iniPath), 1, 60);
        s.actorHz = std::clamp(ReadInt("Telemetry", "ActorHz", s.actorHz, iniPath), 0, 30);
        s.maxActors = std::clamp(ReadInt("Telemetry", "MaxActors", s.maxActors, iniPath), 0, 500);
        return s;
    }

    bool Open(const Settings& settings)
    {
        g_settings = settings;
        if (g_settings.transport == "udp") {
            if (!OpenUdp()) {
                return false;
            }
        } else {
            // Pipe mode never touches Winsock at all.
            g_settings.transport = "pipe";
            g_pipePath = L"\\\\.\\pipe\\" + Widen(g_settings.pipeName);
        }
        std::thread(g_settings.transport == "udp" ? UdpLoop : PipeLoop).detach();
        return true;
    }

    void Send(std::string_view payload)
    {
        {
            std::lock_guard lock(g_lock);
            if (g_queue.size() >= kMaxQueued) {
                g_queue.pop_front();
            }
            g_queue.emplace_back(payload);
        }
        g_wake.notify_one();
    }

    std::string Status()
    {
        if (g_settings.transport == "udp") {
            return "sending UDP";
        }
        std::lock_guard lock(g_statusLock);
        return g_status;
    }

    std::string Describe()
    {
        if (g_settings.transport == "udp") {
            return "UDP " + g_settings.host + ":" + std::to_string(g_settings.port);
        }
        return "named pipe \\\\.\\pipe\\" + g_settings.pipeName;
    }

    namespace
    {
        // Folder of a loaded module (nullptr: the game's exe), UTF-8; "" if it isn't loaded.
        std::string ModuleDirectory(HMODULE module)
        {
            wchar_t buffer[4096]{};
            const DWORD length = GetModuleFileNameW(module, buffer, static_cast<DWORD>(std::size(buffer)));
            if (!length) {
                return {};
            }
            std::wstring path(buffer, length);
            path.resize(std::min(path.find_last_of(L"\\/"), path.size()));
            const int size = WideCharToMultiByte(CP_UTF8, 0, path.c_str(), static_cast<int>(path.size()), nullptr, 0, nullptr, nullptr);
            std::string utf8(static_cast<std::size_t>(size), '\0');
            WideCharToMultiByte(CP_UTF8, 0, path.c_str(), static_cast<int>(path.size()), utf8.data(), size, nullptr, nullptr);
            return utf8;
        }
    }

    std::string GameDirectory()
    {
        return ModuleDirectory(nullptr);
    }

    std::string ModOrganizerDirectory()
    {
        // MO2 injects its virtual file system DLL, which lives next to ModOrganizer.exe.
        const HMODULE usvfs = GetModuleHandleW(L"usvfs_x64.dll");
        return usvfs ? ModuleDirectory(usvfs) : std::string();
    }
}
