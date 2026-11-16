SKYRIM LIVE MAP - companion app
================================

A live 3D map of Skyrim for your second monitor, phone or tablet. It follows your
character, shows quest targets, nearby creatures, interior floor plans and more.

You need two things:
  1. The SKSE plugin (the "Plugin" download), installed with your mod manager.
  2. This app, running on the same PC as the game.


START IT
--------
1. Extract this whole folder anywhere (Desktop, Documents, D:\Tools...). Keep the
   "app" and "runtime" folders next to SkyrimLiveMap.exe.
2. Double-click SkyrimLiveMap.exe. A window opens with the map's address and a QR code.
   Leave it open while you play; close it when you're done.
3. Open the map:
     - on this PC:          http://localhost:8787
     - on a phone/tablet:   scan the QR code, or type the "Other device" address
                            (the phone must be on the same Wi-Fi/network).
4. Launch Skyrim the way you always do (through Mod Organizer 2, Vortex, the Nolvus
   dashboard... with SKSE). The map goes Live.

The first time Windows asks whether to allow Node.js on networks: tick Private
networks and allow it, or phones and tablets can't reach the map.


THE FIRST TIME YOU PLAY A MODLIST
---------------------------------
The map is built from your own game files and load order, so mod-added towns,
locations and terrain changes are on it. The first time a modlist connects, the app
builds its map by itself; that takes a minute or two (the map shows the progress).
After that it opens instantly. Each modlist / mod setup gets its own map, and with the
Modlist picker on Auto the map switches to whichever one you launch.

Changed or updated your modlist? Open the map's panel (the list button) and press
"Rebuild map" under Modlist.

Maps are stored in %LOCALAPPDATA%\SkyrimLiveMap\maps (paste that into Explorer's
address bar). Deleting a folder there just means it's rebuilt next time.


IN THE GAME
-----------
Number pad: Num +/- zoom, Num 8/2/4/6 pan, Num 5 recenter, Num 0 2D/3D,
Num . next map style. With SKSE Menu Framework installed, press F10 for the
"Skyrim Live Map" settings page (connection status, key rebinding, update rates).


TROUBLESHOOTING
---------------
- The map says "Waiting for game": check the plugin is enabled, and that you started
  the game with SKSE. The plugin's log is
  Documents\My Games\Skyrim Special Edition\SKSE\SkyrimLiveMap.log
- A phone can't open the map: allow Node.js through Windows Firewall on Private
  networks (Windows Security > Firewall > Allow an app), and make sure your network
  is set to Private, not Public.
- "Port 8787 is already in use": the app is already running; look in the taskbar.
- A map build failed: the app window shows why. Rebuild it from the panel once fixed.
- Antivirus complaints: the app is a launcher plus standard Node.js and Python
  runtimes; nothing is installed and nothing leaves your network.

To uninstall, delete this folder and %LOCALAPPDATA%\SkyrimLiveMap.

Third-party software and licenses: THIRD-PARTY-NOTICES.txt
