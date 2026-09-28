#include <SDL3_mixer/SDL_mixer.h>
#include "audio_transition.hpp"
#include <cmath>
#include <iostream>
#include <vector>

struct CapturedTrack {
    std::vector<float> samples;
};

static void SDLCALL captureCooked(void* userdata, MIX_Track*, const SDL_AudioSpec*, float* pcm, int sampleCount) {
    auto* capture = static_cast<CapturedTrack*>(userdata);
    capture->samples.insert(capture->samples.end(), pcm, pcm + sampleCount);
}

static bool near(float actual, float expected) {
    return std::abs(actual - expected) < 0.015f;
}

int main() {
    constexpr int sampleRate = 48000;
    constexpr int fadeFrames = sampleRate;
    constexpr float signal = 0.2f;
    SDL_AudioSpec spec{};
    spec.format = SDL_AUDIO_F32;
    spec.channels = 1;
    spec.freq = sampleRate;

    if (!MIX_Init()) { std::cerr << SDL_GetError() << '\n'; return 1; }
    MIX_Mixer* mixer = MIX_CreateMixer(&spec);
    if (!mixer) { std::cerr << SDL_GetError() << '\n'; MIX_Quit(); return 1; }

    std::vector<float> source(sampleRate * 2, signal);
    MIX_Audio* audio = MIX_LoadRawAudio(mixer, source.data(), source.size() * sizeof(float), &spec);
    MIX_Track* outgoing = audio ? MIX_CreateTrack(mixer) : nullptr;
    MIX_Track* incoming = audio ? MIX_CreateTrack(mixer) : nullptr;
    bool ok = audio && outgoing && incoming;
    CapturedTrack outgoingCapture, incomingCapture;
    if (ok) ok = MIX_SetTrackAudio(outgoing, audio) && MIX_SetTrackAudio(incoming, audio);
    if (ok) ok = MIX_SetTrackCookedCallback(outgoing, captureCooked, &outgoingCapture)
        && MIX_SetTrackCookedCallback(incoming, captureCooked, &incomingCapture);
    if (ok) ok = MIX_PlayTrack(outgoing, 0);

    SDL_PropertiesID options = ok ? SDL_CreateProperties() : 0;
    if (ok) ok = options && SDL_SetNumberProperty(options, MIX_PROP_PLAY_FADE_IN_MILLISECONDS_NUMBER, 1000);
    if (ok) ok = MIX_PlayTrack(incoming, options);
    if (options) SDL_DestroyProperties(options);
    if (ok) ok = MIX_StopTrack(outgoing, MIX_TrackMSToFrames(outgoing, 1000));

    std::vector<float> output(fadeFrames, 0.0f);
    if (ok) ok = MIX_Generate(mixer, output.data(), int(output.size() * sizeof(float))) > 0;
    const size_t midpoint = size_t(fadeFrames / 2);
    if (ok) ok = outgoingCapture.samples.size() > midpoint && incomingCapture.samples.size() > midpoint
        && near(outgoingCapture.samples[midpoint], signal * 0.5f)
        && near(incomingCapture.samples[midpoint], signal * 0.5f);

    if (ok) ok = MIX_Generate(mixer, output.data(), int(output.size() * sizeof(float))) > 0;
    if (ok) ok = outgoingCapture.samples.size() >= size_t(fadeFrames)
        && incomingCapture.samples.size() > size_t(fadeFrames + midpoint)
        && near(outgoingCapture.samples[fadeFrames - 1], 0.0f)
        && near(incomingCapture.samples[fadeFrames + midpoint], signal);

    // Interrupt an in-progress A -> B crossfade with B -> C. Existing tracks
    // must fade out from their current gains, not restart from unity or jump.
    MIX_Audio* replacementAudio = ok ? MIX_LoadRawAudio(mixer, source.data(), source.size() * sizeof(float), &spec) : nullptr;
    MIX_Track *trackA = replacementAudio ? MIX_CreateTrack(mixer) : nullptr;
    MIX_Track *trackB = replacementAudio ? MIX_CreateTrack(mixer) : nullptr;
    MIX_Track *trackC = replacementAudio ? MIX_CreateTrack(mixer) : nullptr;
    CapturedTrack captureA, captureB, captureC;
    bool replacementOk = replacementAudio && trackA && trackB && trackC;
    if (replacementOk) replacementOk = MIX_SetTrackAudio(trackA, replacementAudio)
        && MIX_SetTrackAudio(trackB, replacementAudio) && MIX_SetTrackAudio(trackC, replacementAudio);
    if (replacementOk) replacementOk = MIX_SetTrackCookedCallback(trackA, captureCooked, &captureA)
        && MIX_SetTrackCookedCallback(trackB, captureCooked, &captureB)
        && MIX_SetTrackCookedCallback(trackC, captureCooked, &captureC);
    if (replacementOk) replacementOk = MIX_PlayTrack(trackA, 0);
    SDL_PropertiesID fadeBOptions = replacementOk ? SDL_CreateProperties() : 0;
    if (replacementOk) replacementOk = fadeBOptions
        && SDL_SetNumberProperty(fadeBOptions, MIX_PROP_PLAY_FADE_IN_MILLISECONDS_NUMBER, 1000)
        && MIX_PlayTrack(trackB, fadeBOptions)
        && MIX_StopTrack(trackA, MIX_TrackMSToFrames(trackA, 1000));
    if (fadeBOptions) SDL_DestroyProperties(fadeBOptions);
    constexpr size_t beforeReplacementFrames = sampleRate * 2 / 5;
    std::vector<float> segment(beforeReplacementFrames, 0.0f);
    if (replacementOk) replacementOk = MIX_Generate(mixer, segment.data(), int(segment.size() * sizeof(float))) > 0;
    const size_t beforeIndex = beforeReplacementFrames - 1;
    const auto totalReplacementFadeFrames = replacementOk ? MIX_TrackMSToFrames(trackA, 1000) : 0;
    auto remainingFadeA = replacementOk ? MIX_GetTrackFadeFrames(trackA) : 0;
    auto remainingFadeB = replacementOk ? MIX_GetTrackFadeFrames(trackB) : 0;
    bool pausedClockStable = replacementOk && MIX_PauseTrack(trackA) && MIX_PauseTrack(trackB);
    if (pausedClockStable) {
        SDL_Delay(35);
        pausedClockStable = MIX_GetTrackFadeFrames(trackA) == remainingFadeA && MIX_GetTrackFadeFrames(trackB) == remainingFadeB
            && MIX_ResumeTrack(trackA) && MIX_ResumeTrack(trackB);
    }
    if (replacementOk) {
        remainingFadeA = MIX_GetTrackFadeFrames(trackA);
        remainingFadeB = MIX_GetTrackFadeFrames(trackB);
    }
    const float measuredGainA = native_player::gainFromRemainingFrames(1.0f, 0.0f, totalReplacementFadeFrames, remainingFadeA);
    const float measuredGainB = native_player::gainFromRemainingFrames(0.0f, 1.0f, totalReplacementFadeFrames, remainingFadeB);
    if (replacementOk) replacementOk = captureA.samples.size() > beforeIndex && captureB.samples.size() > beforeIndex
        && near(captureA.samples[beforeIndex], signal * 0.6f)
        && near(captureB.samples[beforeIndex], signal * 0.4f)
        && pausedClockStable
        && remainingFadeA < 0 && remainingFadeB > 0
        && near(measuredGainA, 0.6f) && near(measuredGainB, 0.4f);

    SDL_PropertiesID fadeCOptions = replacementOk ? SDL_CreateProperties() : 0;
    if (replacementOk) replacementOk = fadeCOptions
        && SDL_SetNumberProperty(fadeCOptions, MIX_PROP_PLAY_FADE_IN_MILLISECONDS_NUMBER, 1000)
        && MIX_PlayTrack(trackC, fadeCOptions)
        && MIX_SetTrackGain(trackA, measuredGainA)
        && MIX_SetTrackGain(trackB, measuredGainB)
        && MIX_StopTrack(trackA, MIX_TrackMSToFrames(trackA, 1000))
        && MIX_StopTrack(trackB, MIX_TrackMSToFrames(trackB, 1000));
    if (fadeCOptions) SDL_DestroyProperties(fadeCOptions);
    constexpr size_t afterReplacementFrames = sampleRate / 2;
    segment.assign(afterReplacementFrames, 0.0f);
    if (replacementOk) replacementOk = MIX_Generate(mixer, segment.data(), int(segment.size() * sizeof(float))) > 0;
    const size_t interruptedOldTrackMidpoint = beforeReplacementFrames + afterReplacementFrames - 1;
    const size_t interruptedNewTrackMidpoint = afterReplacementFrames - 1;
    if (replacementOk) replacementOk = captureA.samples.size() > interruptedOldTrackMidpoint
        && captureB.samples.size() > interruptedOldTrackMidpoint && captureC.samples.size() > interruptedNewTrackMidpoint
        && near(captureA.samples[interruptedOldTrackMidpoint], signal * 0.3f)
        && near(captureB.samples[interruptedOldTrackMidpoint], signal * 0.2f)
        && near(captureC.samples[interruptedNewTrackMidpoint], signal * 0.5f);
    constexpr size_t replacementRemainderFrames = sampleRate / 2;
    segment.assign(replacementRemainderFrames, 0.0f);
    if (replacementOk) replacementOk = MIX_Generate(mixer, segment.data(), int(segment.size() * sizeof(float))) > 0;
    const size_t replacementOldTracksEnd = beforeReplacementFrames + afterReplacementFrames + replacementRemainderFrames - 1;
    const size_t replacementNewTrackEnd = afterReplacementFrames + replacementRemainderFrames - 1;
    if (replacementOk) replacementOk = captureA.samples.size() > replacementOldTracksEnd
        && captureB.samples.size() > replacementOldTracksEnd && captureC.samples.size() > replacementNewTrackEnd
        && near(captureA.samples[replacementOldTracksEnd], 0.0f)
        && near(captureB.samples[replacementOldTracksEnd], 0.0f)
        && near(captureC.samples[replacementNewTrackEnd], signal);

    if (trackA) MIX_StopTrack(trackA, 0);
    if (trackB) MIX_StopTrack(trackB, 0);
    if (trackC) MIX_StopTrack(trackC, 0);
    if (trackC) MIX_DestroyTrack(trackC);
    if (trackB) MIX_DestroyTrack(trackB);
    if (trackA) MIX_DestroyTrack(trackA);
    if (replacementAudio) MIX_DestroyAudio(replacementAudio);
    if (incoming) MIX_DestroyTrack(incoming);
    if (outgoing) MIX_DestroyTrack(outgoing);
    if (audio) MIX_DestroyAudio(audio);
    MIX_DestroyMixer(mixer);
    MIX_Quit();

    if (!ok || !replacementOk) { std::cerr << "SDL_mixer crossfade gain curve mismatch";
        if (replacementOk == false) std::cerr << " during interrupted replacement (A=" << captureA.samples.size()
            << ", B=" << captureB.samples.size() << ", C=" << captureC.samples.size() << ")";
        std::cerr << '\n'; return 1; }
    std::cout << "PASS Native BGM crossfade gain: linear endpoints, midpoint and interrupted three-track replacement\n";
    return 0;
}
