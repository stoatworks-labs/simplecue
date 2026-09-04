cmake_minimum_required(VERSION 3.22)

# These two MUST be set before project(). CMake's platform module creates both cache
# entries while project() runs, and a later `set(... CACHE ...)` without FORCE is then
# silently ignored — which is how a "universal" macOS build quietly ships as arm64 only.
# Guarded so an explicit -DCMAKE_OSX_ARCHITECTURES on the command line still wins.
if(NOT DEFINED CMAKE_OSX_ARCHITECTURES)
    set(CMAKE_OSX_ARCHITECTURES "arm64;x86_64" CACHE STRING "macOS build architectures")
endif()

if(NOT DEFINED CMAKE_OSX_DEPLOYMENT_TARGET)
    set(CMAKE_OSX_DEPLOYMENT_TARGET "11.0" CACHE STRING "Minimum macOS deployment target")
endif()

project(SimpleCue VERSION 0.4.1 LANGUAGES C CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# --------------------------------------------------------------------------------------
# Optional Steinberg ASIO SDK (Windows only).
#
# The ASIO SDK licence forbids redistribution, so it is never vendored here. Download it
# from https://www.steinberg.net/developers/ and point CMake at the unpacked folder:
#
#     cmake -B build -DSIMPLECUE_ASIO_SDK_PATH=C:/SDKs/asiosdk_2.3.3
#
# Without it, Windows builds still get WASAPI (shared + exclusive) and DirectSound.
# --------------------------------------------------------------------------------------
set(SIMPLECUE_ASIO_SDK_PATH "" CACHE PATH "Path to the unpacked Steinberg ASIO SDK (Windows only)")

# --------------------------------------------------------------------------------------
# Build identity for crash reports.
#
# A compiled binary cannot read its own git revision at runtime, and a crash report that
# only carries a version number is useless during a show: the version has not changed
# since the last release, but the binary on the machine may be three commits past it.
# `-dirty` means the tree had uncommitted changes, so the sha alone does not identify
# the source that was built.
# --------------------------------------------------------------------------------------
find_package(Git QUIET)
set(SIMPLECUE_GIT_REV "unknown")
if(GIT_FOUND)
    execute_process(
        COMMAND ${GIT_EXECUTABLE} rev-parse --short=12 HEAD
        WORKING_DIRECTORY ${CMAKE_CURRENT_SOURCE_DIR}
        OUTPUT_VARIABLE SIMPLECUE_GIT_REV
        OUTPUT_STRIP_TRAILING_WHITESPACE
        ERROR_QUIET
    )
    execute_process(
        COMMAND ${GIT_EXECUTABLE} status --porcelain --untracked-files=no
        WORKING_DIRECTORY ${CMAKE_CURRENT_SOURCE_DIR}
        OUTPUT_VARIABLE SIMPLECUE_GIT_DIRTY
        OUTPUT_STRIP_TRAILING_WHITESPACE
        ERROR_QUIET
    )
    if(NOT SIMPLECUE_GIT_REV)
        set(SIMPLECUE_GIT_REV "unknown")
    elseif(SIMPLECUE_GIT_DIRTY)
        set(SIMPLECUE_GIT_REV "${SIMPLECUE_GIT_REV}-dirty")
    endif()
endif()
message(STATUS "SimpleCue build revision: ${SIMPLECUE_GIT_REV}")

include(FetchContent)
FetchContent_Declare(
    JUCE
    GIT_REPOSITORY https://github.com/juce-framework/JUCE.git
    GIT_TAG 8.0.6
    GIT_SHALLOW TRUE
)
FetchContent_MakeAvailable(JUCE)

juce_add_gui_app(SimpleCue
    COMPANY_NAME "Allan Sargeant"
    BUNDLE_ID "com.allansargeant.simplecue"
    PRODUCT_NAME "SimpleCue"
    VERSION ${PROJECT_VERSION}
    NEEDS_CURL FALSE
    NEEDS_WEB_BROWSER FALSE
)

juce_generate_juce_header(SimpleCue)

target_sources(SimpleCue
    PRIVATE
        Source/Main.cpp
        Source/App/MainComponent.cpp
        Source/App/ScreenshotMode.cpp

        Source/Diag/Diag.cpp

        Source/Model/Cue.cpp
        Source/Model/CueList.cpp
        Source/Model/Show.cpp
        Source/Model/FadeCurve.cpp
        Source/Model/CueStep.cpp
        Source/Model/ControlMessage.cpp
        Source/Model/StreamingSettings.cpp

        Source/Control/ControlHub.cpp
        Source/Control/ControlSettings.cpp
        Source/Control/DmxControl.cpp
        Source/Control/DmxProtocol.cpp
        Source/Control/MidiControl.cpp
        Source/Control/OscControl.cpp

        Source/Audio/AudioEngine.cpp
        Source/Audio/CueVoice.cpp
        Source/Audio/SampleSource.cpp
        Source/Audio/SampleCache.cpp

        Source/GUI/LookAndFeel.cpp
        Source/GUI/TransportBar.cpp
        Source/GUI/CueListComponent.cpp
        Source/GUI/CueInspector.cpp
        Source/GUI/WaveformComponent.cpp
        Source/GUI/RoutingMatrixComponent.cpp
        Source/GUI/AudioSetupWindow.cpp
        Source/GUI/ActiveCuesComponent.cpp
        Source/GUI/ControlSetupWindow.cpp
        Source/GUI/SettingsWindow.cpp
)

target_include_directories(SimpleCue PRIVATE Source)

target_compile_definitions(SimpleCue
    PRIVATE
        JUCE_WEB_BROWSER=0
        JUCE_USE_CURL=0
        JUCE_APPLICATION_NAME_STRING="$<TARGET_PROPERTY:SimpleCue,JUCE_PRODUCT_NAME>"
        JUCE_APPLICATION_VERSION_STRING="$<TARGET_PROPERTY:SimpleCue,JUCE_VERSION>"
        JUCE_DISPLAY_SPLASH_SCREEN=0
        JUCE_MODAL_LOOPS_PERMITTED=0
        DIAG_GIT_REV="${SIMPLECUE_GIT_REV}"
)

# ---- Audio backends -----------------------------------------------------------------
# Each backend is enabled only where its headers actually exist, so a build never fails
# looking for, say, jack/jack.h on a Mac.
if(WIN32)
    # WASAPI shared and exclusive (exclusive is the low-latency path), plus DirectSound
    # as the fallback for older or unusual drivers. ASIO is handled separately below.
    target_compile_definitions(SimpleCue PRIVATE
        JUCE_WASAPI=1
        JUCE_WASAPI_EXCLUSIVE=1
        JUCE_DIRECTSOUND=1)
elseif(APPLE)
    # CoreAudio is always compiled in by JUCE on macOS; nothing to switch on.
    # JACK is available on macOS too, but only if the user has installed its headers.
    find_path(SIMPLECUE_JACK_INCLUDE_DIR jack/jack.h
              PATHS /usr/local/include /opt/homebrew/include /usr/include)

    if(SIMPLECUE_JACK_INCLUDE_DIR)
        message(STATUS "SimpleCue: JACK support enabled (${SIMPLECUE_JACK_INCLUDE_DIR})")
        target_compile_definitions(SimpleCue PRIVATE JUCE_JACK=1)
        target_include_directories(SimpleCue PRIVATE ${SIMPLECUE_JACK_INCLUDE_DIR})
    endif()
else()
    # Linux. ALSA is the baseline; JACK covers pro audio setups. PipeWire needs neither
    # of its own — it is reached through its ALSA and JACK compatibility layers, and
    # appears there as an ordinary device.
    target_compile_definitions(SimpleCue PRIVATE JUCE_ALSA=1)

    find_path(SIMPLECUE_JACK_INCLUDE_DIR jack/jack.h PATHS /usr/include /usr/local/include)

    if(SIMPLECUE_JACK_INCLUDE_DIR)
        message(STATUS "SimpleCue: JACK support enabled")
        target_compile_definitions(SimpleCue PRIVATE JUCE_JACK=1)
        target_include_directories(SimpleCue PRIVATE ${SIMPLECUE_JACK_INCLUDE_DIR})
    else()
        message(STATUS "SimpleCue: JACK headers not found (install libjack-jackd2-dev "
                       "or pipewire-jack headers to enable it). ALSA remains available.")
    endif()
endif()

# ---- ASIO ---------------------------------------------------------------------------
if(WIN32 AND SIMPLECUE_ASIO_SDK_PATH)
    if(EXISTS "${SIMPLECUE_ASIO_SDK_PATH}/common/iasiodrv.h")
        message(STATUS "SimpleCue: ASIO enabled (SDK at ${SIMPLECUE_ASIO_SDK_PATH})")
        target_compile_definitions(SimpleCue PRIVATE JUCE_ASIO=1)
        target_include_directories(SimpleCue PRIVATE "${SIMPLECUE_ASIO_SDK_PATH}/common")
    else()
        message(FATAL_ERROR
            "SIMPLECUE_ASIO_SDK_PATH is set to '${SIMPLECUE_ASIO_SDK_PATH}' but "
            "common/iasiodrv.h was not found there. Point it at the unpacked ASIO SDK root.")
    endif()
elseif(WIN32)
    message(STATUS "SimpleCue: ASIO disabled (set SIMPLECUE_ASIO_SDK_PATH to enable). "
                   "WASAPI and DirectSound remain available.")
endif()

# ---- Diagnostics crash example ------------------------------------------------------
# Deliberately crashes, so the crash handler is something that has been observed working
# rather than assumed. See docs/diagnostics.md.
juce_add_console_app(SimpleCueDiagCrash PRODUCT_NAME "SimpleCueDiagCrash")

target_sources(SimpleCueDiagCrash PRIVATE Tests/DiagCrashExample.cpp Source/Diag/Diag.cpp)
target_include_directories(SimpleCueDiagCrash PRIVATE Source)

target_compile_definitions(SimpleCueDiagCrash
    PRIVATE
        JUCE_WEB_BROWSER=0
        JUCE_USE_CURL=0
        JUCE_STANDALONE_APPLICATION=1
        DIAG_GIT_REV="${SIMPLECUE_GIT_REV}")

target_link_libraries(SimpleCueDiagCrash
    PRIVATE
        juce::juce_core
        juce::juce_events
    PUBLIC
        juce::juce_recommended_config_flags
        juce::juce_recommended_warning_flags)

# ---- Engine tests -------------------------------------------------------------------
# Console harness that drives the real CueVoice with a ramp signal and checks positions,
# fades, loops and vamps numerically. Run with: ./build/SimpleCueTests
juce_add_console_app(SimpleCueTests PRODUCT_NAME "SimpleCueTests")

target_sources(SimpleCueTests
    PRIVATE
        Tests/EngineTests.cpp
        Tests/ControlTests.cpp
        Source/Model/Cue.cpp
        Source/Model/CueList.cpp
        Source/Model/Show.cpp
        Source/Model/FadeCurve.cpp
        Source/Model/CueStep.cpp
        Source/Model/ControlMessage.cpp
        Source/Model/StreamingSettings.cpp
        Source/Control/ControlSettings.cpp
        Source/Control/DmxProtocol.cpp
        Source/Control/DmxControl.cpp
        Source/Control/MidiControl.cpp
        Source/Control/OscControl.cpp
        Source/Audio/CueVoice.cpp
        Source/Audio/SampleSource.cpp
        Source/GUI/LookAndFeel.cpp)

target_include_directories(SimpleCueTests PRIVATE Source Tests)

target_compile_definitions(SimpleCueTests
    PRIVATE
        JUCE_WEB_BROWSER=0
        JUCE_USE_CURL=0
        JUCE_STANDALONE_APPLICATION=1
        # So the suite can assert on the save path's source. The atomicity of a
        # replace is a property of which API is called, not of any state a test
        # can observe afterwards — see testShowSaveIsAtomic.
        SIMPLECUE_SOURCE_DIR="${CMAKE_CURRENT_SOURCE_DIR}/Source")

target_link_libraries(SimpleCueTests
    PRIVATE
        juce::juce_audio_formats
        juce::juce_audio_basics
        juce::juce_audio_devices
        juce::juce_events
        juce::juce_gui_basics
        juce::juce_osc
    PUBLIC
        juce::juce_recommended_config_flags
        juce::juce_recommended_warning_flags)

enable_testing()
add_test(NAME engine COMMAND SimpleCueTests)

target_link_libraries(SimpleCue
    PRIVATE
        juce::juce_audio_utils
        juce::juce_audio_devices
        juce::juce_audio_formats
        juce::juce_dsp
        juce::juce_gui_extra
        juce::juce_osc
    PUBLIC
        juce::juce_recommended_config_flags
        juce::juce_recommended_lto_flags
        juce::juce_recommended_warning_flags
)
