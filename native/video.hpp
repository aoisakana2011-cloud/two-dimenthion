#pragma once
#include <SDL3/SDL.h>
extern "C" {
#include <libavformat/avformat.h>
#include <libavcodec/avcodec.h>
#include <libswscale/swscale.h>
#include <libswresample/swresample.h>
}
#include <vector>
#include <stdexcept>
#include <string>

class Video {
    AVFormatContext* input = nullptr;
    AVCodecContext *video = nullptr, *audio = nullptr;
    AVFrame *frame = nullptr, *audioFrame = nullptr;
    AVPacket* packet = nullptr;
    SwsContext* scaler = nullptr;
    SwrContext* resampler = nullptr;
    SDL_AudioStream* sound = nullptr;
    int videoIndex = -1, audioIndex = -1;
    bool eof = false, pending = false;
    double nextTime = 0, origin = 0;
    uint64_t start = 0;
    std::vector<uint8_t> pixels;
    AVCodecContext* decoder(int index) {
        auto* codec = avcodec_find_decoder(input->streams[index]->codecpar->codec_id);
        auto* ctx = avcodec_alloc_context3(codec);
        if (!ctx || avcodec_parameters_to_context(ctx, input->streams[index]->codecpar) < 0 || avcodec_open2(ctx, codec, nullptr) < 0) {
            avcodec_free_context(&ctx); throw std::runtime_error("Cannot open media decoder");
        }
        return ctx;
    }
    void drainAudio() {
        while (avcodec_receive_frame(audio, audioFrame) == 0) {
            int capacity = swr_get_out_samples(resampler, audioFrame->nb_samples);
            std::vector<float> samples(capacity * 2);
            uint8_t* out = reinterpret_cast<uint8_t*>(samples.data());
            int count = swr_convert(resampler, &out, capacity, const_cast<const uint8_t**>(audioFrame->extended_data), audioFrame->nb_samples);
            if (count < 0 || !SDL_PutAudioStreamData(sound, samples.data(), count * 2 * sizeof(float))) throw std::runtime_error("Video audio conversion failed");
        }
    }
    bool next() {
        for (;;) {
            int status = avcodec_receive_frame(video, frame);
            if (status == 0) {
                nextTime = frame->best_effort_timestamp == AV_NOPTS_VALUE ? nextTime + 1.0 / 30 : frame->best_effort_timestamp * av_q2d(input->streams[videoIndex]->time_base) - origin;
                pending = true; return true;
            }
            if (status == AVERROR_EOF) return false;
            if (status != AVERROR(EAGAIN)) throw std::runtime_error("Video decode failed");
            if (eof) return false;
            if (av_read_frame(input, packet) < 0) {
                eof = true; avcodec_send_packet(video, nullptr);
                if (audio) { avcodec_send_packet(audio, nullptr); drainAudio(); SDL_FlushAudioStream(sound); }
                continue;
            }
            if (packet->stream_index == videoIndex) {
                if (avcodec_send_packet(video, packet) < 0) throw std::runtime_error("Video packet failed");
            } else if (audio && packet->stream_index == audioIndex) {
                if (avcodec_send_packet(audio, packet) < 0) throw std::runtime_error("Audio packet failed");
                drainAudio();
            }
            av_packet_unref(packet);
        }
    }
public:
    SDL_Texture* texture = nullptr;
    bool finished = false;
    Video(SDL_Renderer* renderer, const std::string& path) {
        try {
            if (avformat_open_input(&input, path.c_str(), nullptr, nullptr) < 0 || avformat_find_stream_info(input, nullptr) < 0) throw std::runtime_error("Cannot open video: " + path);
            videoIndex = av_find_best_stream(input, AVMEDIA_TYPE_VIDEO, -1, -1, nullptr, 0);
            audioIndex = av_find_best_stream(input, AVMEDIA_TYPE_AUDIO, -1, -1, nullptr, 0);
            if (videoIndex < 0) throw std::runtime_error("No video stream");
            video = decoder(videoIndex); frame = av_frame_alloc(); audioFrame = av_frame_alloc(); packet = av_packet_alloc();
            auto* stream = input->streams[videoIndex];
            origin = stream->start_time == AV_NOPTS_VALUE ? 0 : stream->start_time * av_q2d(stream->time_base);
            texture = SDL_CreateTexture(renderer, SDL_PIXELFORMAT_RGBA32, SDL_TEXTUREACCESS_STREAMING, video->width, video->height);
            if (!texture) throw std::runtime_error(SDL_GetError());
            scaler = sws_getContext(video->width, video->height, video->pix_fmt, video->width, video->height, AV_PIX_FMT_RGBA, SWS_BILINEAR, nullptr, nullptr, nullptr);
            if (!scaler) throw std::runtime_error("Cannot create video scaler");
            pixels.resize(static_cast<size_t>(video->width) * video->height * 4);
            if (audioIndex >= 0) {
                audio = decoder(audioIndex); AVChannelLayout stereo = AV_CHANNEL_LAYOUT_STEREO;
                if (swr_alloc_set_opts2(&resampler, &stereo, AV_SAMPLE_FMT_FLT, 48000, &audio->ch_layout, audio->sample_fmt, audio->sample_rate, 0, nullptr) < 0 || swr_init(resampler) < 0) throw std::runtime_error("Cannot create audio resampler");
                SDL_AudioSpec spec{SDL_AUDIO_F32, 2, 48000};
                sound = SDL_OpenAudioDeviceStream(SDL_AUDIO_DEVICE_DEFAULT_PLAYBACK, &spec, nullptr, nullptr);
                if (!sound) throw std::runtime_error(SDL_GetError());
            }
            next(); start = SDL_GetTicks(); if (sound) SDL_ResumeAudioStreamDevice(sound);
        } catch (...) { close(); throw; }
    }
    void update() {
        while (pending && (SDL_GetTicks() - start) / 1000.0 >= nextTime) {
            uint8_t* out = pixels.data(); int stride = video->width * 4;
            sws_scale(scaler, frame->data, frame->linesize, 0, video->height, &out, &stride);
            SDL_UpdateTexture(texture, nullptr, pixels.data(), stride);
            pending = false;
            if (!next()) { finished = !sound || SDL_GetAudioStreamQueued(sound) == 0; break; }
        }
        if (eof && !pending && (!sound || SDL_GetAudioStreamQueued(sound) == 0)) finished = true;
    }
    void close() {
        if (sound) SDL_DestroyAudioStream(sound);
        if (texture) SDL_DestroyTexture(texture);
        if (scaler) sws_freeContext(scaler);
        swr_free(&resampler); av_frame_free(&frame); av_frame_free(&audioFrame); av_packet_free(&packet);
        avcodec_free_context(&video); avcodec_free_context(&audio); avformat_close_input(&input);
    }
    SDL_Texture* releaseTexture() { auto* result = texture; texture = nullptr; return result; }
    ~Video() { close(); }
};
