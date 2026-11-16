cmake_minimum_required(VERSION 3.21)

project(SkyrimLiveMap VERSION 1.0.0 LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 23)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>DLL")

find_package(CommonLibSSE CONFIG REQUIRED)

add_commonlibsse_plugin(${PROJECT_NAME}
    AUTHOR "Skyrim Live Map"
    SOURCES
        src/Character.cpp
        src/Discovery.cpp
        src/Hotkeys.cpp
        src/Ini.cpp
        src/main.cpp
        src/Menu.cpp
        src/Player.cpp
        src/Quests.cpp
        src/Relay.cpp
        src/Telemetry.cpp
)

target_precompile_headers(${PROJECT_NAME} PRIVATE src/PCH.h)
set_source_files_properties(src/Relay.cpp src/Ini.cpp PROPERTIES SKIP_PRECOMPILE_HEADERS ON)
# /EHa: the crash guard in Telemetry.cpp catches access violations; this makes
# destructors (lock guards etc.) run while such an exception unwinds.
target_compile_options(${PROJECT_NAME} PRIVATE /W4 /permissive- /utf-8 /Zc:preprocessor /EHa)
target_link_libraries(${PROJECT_NAME} PRIVATE ws2_32)
# A linker map turns crash-log offsets (SkyrimLiveMap.dll+0x...) into function names.
target_link_options(${PROJECT_NAME} PRIVATE /MAP)

# Optional: set SKYRIM_DATA to your Data folder to copy the DLL there after each build.
if(DEFINED ENV{SKYRIM_DATA})
    add_custom_command(TARGET ${PROJECT_NAME} POST_BUILD
        COMMAND ${CMAKE_COMMAND} -E make_directory "$ENV{SKYRIM_DATA}/SKSE/Plugins"
        COMMAND ${CMAKE_COMMAND} -E copy_if_different "$<TARGET_FILE:${PROJECT_NAME}>" "$ENV{SKYRIM_DATA}/SKSE/Plugins/"
        COMMAND ${CMAKE_COMMAND} -E copy_if_different "${CMAKE_SOURCE_DIR}/SkyrimLiveMap.ini" "$ENV{SKYRIM_DATA}/SKSE/Plugins/")
endif()
