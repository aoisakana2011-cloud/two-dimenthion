Package: ffmpeg[avcodec,avdevice,avfilter,avformat,core,swresample,swscale]:x64-windows@9.0.1#1

**Host Environment**

- Host: x64-windows
- Compiler: MSVC 19.51.36252.0
- CMake Version: 4.4.2
-    vcpkg-tool version: 2026-07-27-98d7cb0cf1f4686a3e43aa5672b6230c1d56bce8
    vcpkg-scripts version: 04a9d8e5 2026-09-03 (10 hours ago)

**To Reproduce**

`vcpkg install `

**Failure logs**

```
-- Using cached ffmpeg-ffmpeg-n9.0.1.tar.gz
-- Extracting source C:/Users/Owner/Desktop/Novel Editer/native/.vcpkg/downloads/ffmpeg-ffmpeg-n9.0.1.tar.gz
-- Applying patch 0003-fix-windowsinclude.patch
-- Applying patch 0004-dependencies.patch
-- Applying patch 0005-fix-nasm.patch
-- Applying patch 0007-fix-lib-naming.patch
-- Applying patch 0013-define-WINVER.patch
-- Applying patch 0024-fix-osx-host-c11.patch
-- Applying patch 0040-ffmpeg-add-av_stream_get_first_dts-for-chromium.patch
-- Applying patch 0045-use-prebuilt-bin2c.patch
-- Applying patch 0046-fix-msvc-detection.patch
-- Applying patch 0047-fix-msvc-utf8.patch
-- Applying patch 0049-fix-twolame-pkgconfig.patch
-- Applying patch 0050-fix-test-ld-absolute-lib-paths.patch
-- Applying patch 0051-fix-msvc-undef-flags.patch
-- Applying patch 0052-fix-disable-unstable-swscale-link.patch
-- Using source at C:/Users/Owner/Desktop/Novel Editer/native/.vcpkg/buildtrees/ffmpeg/src/n9.0.1-1250e74153.clean
CMake Error at ports/ffmpeg/portfile.cmake:25 (message):
  Error: ffmpeg will not build with spaces in the path.  Please use a
  directory with no spaces
Call Stack (most recent call first):
  scripts/ports.cmake:209 (include)



```

**Additional context**

<details><summary>vcpkg.json</summary>

```
{
  "name": "novel-script-native",
  "version-string": "0.1.0",
  "dependencies": [
    "sdl3",
    "sdl3-ttf",
    "sdl3-image",
    "sdl3-mixer",
    "ffmpeg"
  ]
}

```
</details>
