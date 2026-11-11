// tr_mme_mp4.cpp -- Standard Fast-Start MP4 muxer (ftyp + moov + mdat) + WebCodecs H.264 & vo-aacenc AAC-LC

#include "tr_mme.h"
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <math.h>
#include <vector>

#ifdef __EMSCRIPTEN__
#include <emscripten.h>
extern "C" {
#include "voAAC.h"
#include "cmnMemory.h"
}
#endif

enum {
	MP4_TRACK_NONE  = 0,
	MP4_TRACK_VIDEO = 1,
	MP4_TRACK_AUDIO = 2,
};

struct Mp4VideoSampleMeta {
	uint32_t size;
	uint32_t duration90k;
	int64_t pts90k;
	uint8_t isKeyframe;
};

struct Mp4AudioSampleMeta {
	uint32_t size;
	uint32_t durationTicks;
};

struct Mp4ChunkRun {
	uint64_t spoolOffset;
	uint32_t sampleCount;
};

struct Mp4RlePair {
	uint32_t count;
	uint32_t value;
};

struct Mp4ByteBuf {
	std::vector<uint8_t> b;

	void u8(uint8_t v) {
		b.push_back(v);
	}
	void u16(uint16_t v) {
		b.push_back((uint8_t)((v >> 8) & 0xFF));
		b.push_back((uint8_t)(v & 0xFF));
	}
	void u24(uint32_t v) {
		b.push_back((uint8_t)((v >> 16) & 0xFF));
		b.push_back((uint8_t)((v >> 8) & 0xFF));
		b.push_back((uint8_t)(v & 0xFF));
	}
	void u32(uint32_t v) {
		b.push_back((uint8_t)((v >> 24) & 0xFF));
		b.push_back((uint8_t)((v >> 16) & 0xFF));
		b.push_back((uint8_t)((v >> 8) & 0xFF));
		b.push_back((uint8_t)(v & 0xFF));
	}
	void i32(int32_t v) {
		u32((uint32_t)v);
	}
	void u64(uint64_t v) {
		u32((uint32_t)(v >> 32));
		u32((uint32_t)(v & 0xFFFFFFFFu));
	}
	void fourcc(const char s[4]) {
		b.push_back((uint8_t)s[0]);
		b.push_back((uint8_t)s[1]);
		b.push_back((uint8_t)s[2]);
		b.push_back((uint8_t)s[3]);
	}
	void descrLen(uint32_t len) {
		u8(0x80u | (uint8_t)((len >> 21) & 0x7Fu));
		u8(0x80u | (uint8_t)((len >> 14) & 0x7Fu));
		u8(0x80u | (uint8_t)((len >> 7) & 0x7Fu));
		u8((uint8_t)(len & 0x7Fu));
	}
	void bytes(const void *p, size_t n) {
		if (n > 0 && p) {
			const uint8_t *sp = (const uint8_t *)p;
			b.insert(b.end(), sp, sp + n);
		}
	}
	void zeros(size_t n) {
		if (n > 0) {
			b.insert(b.end(), n, 0);
		}
	}
	size_t beginBox(const char type[4]) {
		size_t pos = b.size();
		u32(0);
		fourcc(type);
		return pos;
	}
	size_t beginFullBox(const char type[4], uint8_t version, uint32_t flags) {
		size_t pos = beginBox(type);
		u8(version);
		u24(flags);
		return pos;
	}
	void endBox(size_t pos) {
		uint32_t sz = (uint32_t)(b.size() - pos);
		patchU32(pos, sz);
	}
	void patchU32(size_t pos, uint32_t u) {
		b[pos + 0] = (uint8_t)((u >> 24) & 0xFF);
		b[pos + 1] = (uint8_t)((u >> 16) & 0xFF);
		b[pos + 2] = (uint8_t)((u >> 8) & 0xFF);
		b[pos + 3] = (uint8_t)(u & 0xFF);
	}
	void patchU64(size_t pos, uint64_t u) {
		patchU32(pos, (uint32_t)(u >> 32));
		patchU32(pos + 4, (uint32_t)(u & 0xFFFFFFFFu));
	}
};

struct Mp4Session {
	char name[MAX_OSPATH];
	char tempRawName[MAX_OSPATH];
	fileHandle_t rawFile;
	qboolean pipe;
	qboolean audioEnabled;
	int width;
	int height;
	float fps;

	bool spoolOpened;
	bool closed;
	int jsEncoderId;

	std::vector<uint8_t> avcC;
	int audioSampleRate;
	int audioBitrate;
	std::vector<uint8_t> audioConfig;

	uint64_t spoolBytesWritten;
	int lastChunkTrack;
	bool hasBasePts;
	int64_t basePtsUs;

	std::vector<Mp4VideoSampleMeta> videoSamples;
	std::vector<Mp4AudioSampleMeta> audioSamples;
	std::vector<Mp4ChunkRun> videoChunks;
	std::vector<Mp4ChunkRun> audioChunks;

#ifdef __EMSCRIPTEN__
	VO_AUDIO_CODECAPI aacApi;
	VO_HANDLE aacHandle;
	VO_MEM_OPERATOR aacMemOp;
	bool aacReady;
	uint8_t pcmBuf[8192];
	int pcmBytes;
#endif

	Mp4Session()
		: rawFile(0), pipe(qfalse), audioEnabled(qfalse), width(0), height(0), fps(60.0f),
		  spoolOpened(false), closed(false), jsEncoderId(0),
		  audioSampleRate(44100), audioBitrate(128000),
		  spoolBytesWritten(0), lastChunkTrack(MP4_TRACK_NONE),
		  hasBasePts(false), basePtsUs(0)
#ifdef __EMSCRIPTEN__
		  , aacHandle(0), aacReady(false), pcmBytes(0)
#endif
	{
		name[0] = '\0';
		tempRawName[0] = '\0';
#ifdef __EMSCRIPTEN__
		memset(&aacApi, 0, sizeof(aacApi));
		memset(&aacMemOp, 0, sizeof(aacMemOp));
#endif
	}
};

static int s_mp4CapturedFrames = 0;
static double s_mp4EncodedBytes = 0.0;
static int s_mp4PendingFlushes = 0;

#ifdef __EMSCRIPTEN__
EM_JS(int, wasm_js_mp4_spool_open, (), {
	try {
		var g = typeof globalThis !== 'undefined' ? globalThis : (typeof self !== 'undefined' ? self : window);
		if (g && typeof g.__jkMp4SpoolOpen === 'function') {
			return g.__jkMp4SpoolOpen() | 0;
		}
	} catch (e) {
		console.error('wasm_js_mp4_spool_open error:', e);
	}
	return 0;
});

EM_JS(int, wasm_js_mp4_spool_write, (const void *ptr, int len), {
	try {
		if (len <= 0 || !ptr) return 0;
		var g = typeof globalThis !== 'undefined' ? globalThis : (typeof self !== 'undefined' ? self : window);
		if (g && typeof g.__jkMp4SpoolWrite === 'function') {
			var base = ptr >>> 0;
			var view = HEAPU8.subarray(base, base + (len >>> 0));
			return g.__jkMp4SpoolWrite(view) | 0;
		}
	} catch (e) {
		console.error('wasm_js_mp4_spool_write error:', e);
	}
	return 0;
});

EM_JS(void, wasm_js_mp4_spool_finalize, (const void *hdrPtr, int hdrLen, double payloadBytes), {
	try {
		var g = typeof globalThis !== 'undefined' ? globalThis : (typeof self !== 'undefined' ? self : window);
		if (g && typeof g.__jkMp4SpoolFinalize === 'function') {
			var hdrCopy = new Uint8Array(hdrLen > 0 ? hdrLen : 0);
			if (hdrLen > 0 && hdrPtr) {
				var base = hdrPtr >>> 0;
				hdrCopy.set(HEAPU8.subarray(base, base + (hdrLen >>> 0)));
			}
			g.__jkMp4SpoolFinalize(hdrCopy, payloadBytes);
		}
	} catch (e) {
		console.error('wasm_js_mp4_spool_finalize error:', e);
	}
});
#endif

static void Mp4WriteUnityMatrix(Mp4ByteBuf &buf) {
	buf.u32(0x00010000u); buf.u32(0); buf.u32(0);
	buf.u32(0); buf.u32(0x00010000u); buf.u32(0);
	buf.u32(0); buf.u32(0); buf.u32(0x40000000u);
}

static bool Mp4EnsureSpoolOpen(Mp4Session *s) {
	if (s->spoolOpened)
		return true;
	if (s->pipe) {
#ifdef __EMSCRIPTEN__
		if (!wasm_js_mp4_spool_open())
			return false;
		s->spoolOpened = true;
		return true;
#else
		return false;
#endif
	}
	Com_sprintf(s->tempRawName, sizeof(s->tempRawName), "%s.mp4.raw", s->name[0] ? s->name : "capture");
	s->rawFile = ri.FS_FOpenFileWrite(s->tempRawName);
	if (!s->rawFile)
		return false;
	s->spoolOpened = true;
	return true;
}

static bool Mp4AppendSamplePayload(Mp4Session *s, int trackType, const uint8_t *data, uint32_t len) {
	if (!s || !data || len == 0)
		return false;
	if (!Mp4EnsureSpoolOpen(s))
		return false;

	uint64_t sampleOffset = s->spoolBytesWritten;
	if (s->pipe) {
#ifdef __EMSCRIPTEN__
		int written = wasm_js_mp4_spool_write(data, (int)len);
		if (written != (int)len)
			return false;
#else
		return false;
#endif
	} else {
		ri.FS_Write(data, (int)len, s->rawFile);
	}

	std::vector<Mp4ChunkRun> &chunks = (trackType == MP4_TRACK_VIDEO) ? s->videoChunks : s->audioChunks;
	const uint32_t maxSamplesPerChunk = (trackType == MP4_TRACK_VIDEO) ? 30u : 32u;
	if (s->lastChunkTrack == trackType && !chunks.empty() && chunks.back().sampleCount < maxSamplesPerChunk) {
		chunks.back().sampleCount++;
	} else {
		Mp4ChunkRun cr;
		cr.spoolOffset = sampleOffset;
		cr.sampleCount = 1u;
		chunks.push_back(cr);
		s->lastChunkTrack = trackType;
	}

	s->spoolBytesWritten += (uint64_t)len;
	s_mp4EncodedBytes = (double)s->spoolBytesWritten;
	return true;
}

static bool Mp4IsValidAvcc(const uint8_t *data, size_t len) {
	if (!data || len < 5)
		return false;
	size_t pos = 0;
	while (pos + 4 <= len) {
		uint32_t n = ((uint32_t)data[pos] << 24) |
		             ((uint32_t)data[pos + 1] << 16) |
		             ((uint32_t)data[pos + 2] << 8) |
		             (uint32_t)data[pos + 3];
		if (n == 0 || pos + 4 + (size_t)n > len)
			return false;
		pos += 4 + (size_t)n;
	}
	return pos == len;
}

static void Mp4BuildAvcCFromSpsPps(const uint8_t *sps, size_t spsLen, const uint8_t *pps, size_t ppsLen, std::vector<uint8_t> &outAvcC) {
	if (!sps || spsLen < 4 || !pps || ppsLen < 1)
		return;
	outAvcC.clear();
	outAvcC.push_back(1);      // configurationVersion = 1
	outAvcC.push_back(sps[1]); // AVCProfileIndication
	outAvcC.push_back(sps[2]); // profile_compatibility
	outAvcC.push_back(sps[3]); // AVCLevelIndication
	outAvcC.push_back(0xFFu);  // lengthSizeMinusOne = 3 (4-byte NALU lengths)
	outAvcC.push_back(0xE1u);  // numOfSequenceParameterSets = 1
	outAvcC.push_back((uint8_t)((spsLen >> 8) & 0xFF));
	outAvcC.push_back((uint8_t)(spsLen & 0xFF));
	outAvcC.insert(outAvcC.end(), sps, sps + spsLen);
	outAvcC.push_back(1);      // numOfPictureParameterSets = 1
	outAvcC.push_back((uint8_t)((ppsLen >> 8) & 0xFF));
	outAvcC.push_back((uint8_t)(ppsLen & 0xFF));
	outAvcC.insert(outAvcC.end(), pps, pps + ppsLen);
	if (sps[1] == 100 || sps[1] == 110 || sps[1] == 122 || sps[1] == 244) {
		outAvcC.push_back(0xFDu); // chroma_format = 1 (4:2:0)
		outAvcC.push_back(0xF8u); // bit_depth_luma_minus8 = 0
		outAvcC.push_back(0xF8u); // bit_depth_chroma_minus8 = 0
		outAvcC.push_back(0);     // numOfSequenceParameterSetExt = 0
	}
}

static void Mp4ExtractAvcCFromAvccSample(const uint8_t *data, size_t len, std::vector<uint8_t> &outAvcC) {
	const uint8_t *sps = NULL;
	size_t spsLen = 0;
	const uint8_t *pps = NULL;
	size_t ppsLen = 0;
	size_t pos = 0;
	while (pos + 4 <= len) {
		uint32_t n = ((uint32_t)data[pos] << 24) |
		             ((uint32_t)data[pos + 1] << 16) |
		             ((uint32_t)data[pos + 2] << 8) |
		             (uint32_t)data[pos + 3];
		if (n == 0 || pos + 4 + (size_t)n > len)
			break;
		const uint8_t *nal = data + pos + 4;
		uint8_t nalType = nal[0] & 0x1Fu;
		if (nalType == 7 && !sps) {
			sps = nal;
			spsLen = n;
		} else if (nalType == 8 && !pps) {
			pps = nal;
			ppsLen = n;
		}
		pos += 4 + (size_t)n;
	}
	if (sps && pps) {
		Mp4BuildAvcCFromSpsPps(sps, spsLen, pps, ppsLen, outAvcC);
	}
}

static bool Mp4ConvertAnnexBToAvcc(const uint8_t *data, size_t len, std::vector<uint8_t> &outAvcc, std::vector<uint8_t> &ioAvcC) {
	outAvcc.clear();
	if (!data || len < 4)
		return false;

	const uint8_t *sps = NULL;
	size_t spsLen = 0;
	const uint8_t *pps = NULL;
	size_t ppsLen = 0;

	size_t i = 0;
	while (i + 3 < len) {
		size_t scLen = 0;
		if (data[i] == 0 && data[i + 1] == 0 && data[i + 2] == 1) {
			scLen = 3;
		} else if (i + 4 <= len && data[i] == 0 && data[i + 1] == 0 && data[i + 2] == 0 && data[i + 3] == 1) {
			scLen = 4;
		}
		if (scLen > 0) {
			size_t nalStart = i + scLen;
			size_t j = nalStart;
			while (j + 3 <= len) {
				if (data[j] == 0 && data[j + 1] == 0 &&
				    (data[j + 2] == 1 || (j + 3 < len && data[j + 2] == 0 && data[j + 3] == 1))) {
					break;
				}
				j++;
			}
			size_t nalEnd = (j + 3 <= len) ? j : len;
			while (nalEnd > nalStart && data[nalEnd - 1] == 0) {
				nalEnd--;
			}
			size_t nalLen = nalEnd - nalStart;
			if (nalLen > 0) {
				const uint8_t *nal = data + nalStart;
				uint8_t nalType = nal[0] & 0x1Fu;
				if (nalType == 7) {
					if (!sps) { sps = nal; spsLen = nalLen; }
				} else if (nalType == 8) {
					if (!pps) { pps = nal; ppsLen = nalLen; }
				} else if (nalType != 9) {
					outAvcc.push_back((uint8_t)((nalLen >> 24) & 0xFF));
					outAvcc.push_back((uint8_t)((nalLen >> 16) & 0xFF));
					outAvcc.push_back((uint8_t)((nalLen >> 8) & 0xFF));
					outAvcc.push_back((uint8_t)(nalLen & 0xFF));
					outAvcc.insert(outAvcc.end(), nal, nal + nalLen);
				}
			}
			i = (j + 3 <= len) ? j : len;
		} else {
			i++;
		}
	}

	if (ioAvcC.empty() && sps && pps) {
		Mp4BuildAvcCFromSpsPps(sps, spsLen, pps, ppsLen, ioAvcC);
	}
	return !outAvcc.empty();
}

#ifdef __EMSCRIPTEN__
static bool Mp4InitAacEncoder(Mp4Session *s) {
	if (!s || s->aacReady)
		return s && s->aacReady;
	if (voGetAACEncAPI(&s->aacApi) != VO_ERR_NONE || !s->aacApi.Init)
		return false;

	s->aacMemOp.Alloc = cmnMemAlloc;
	s->aacMemOp.Copy = cmnMemCopy;
	s->aacMemOp.Free = cmnMemFree;
	s->aacMemOp.Set = cmnMemSet;
	s->aacMemOp.Check = cmnMemCheck;

	VO_CODEC_INIT_USERDATA userData;
	memset(&userData, 0, sizeof(userData));
	userData.memflag = VO_IMF_USERMEMOPERATOR;
	userData.memData = &s->aacMemOp;

	if (s->aacApi.Init(&s->aacHandle, VO_AUDIO_CodingAAC, &userData) != VO_ERR_NONE || !s->aacHandle)
		return false;

	AACENC_PARAM params;
	memset(&params, 0, sizeof(params));
	params.sampleRate = 44100;
	params.bitRate = (s->audioBitrate >= 64000 && s->audioBitrate <= 320000) ? s->audioBitrate : 128000;
	params.nChannels = 2;
	params.adtsUsed = 0; // Raw ISO MPEG-4 AAC-LC elementary frames (mp4a.40.2)

	if (s->aacApi.SetParam(s->aacHandle, VO_PID_AAC_ENCPARAM, &params) != VO_ERR_NONE) {
		s->aacApi.Uninit(s->aacHandle);
		s->aacHandle = 0;
		return false;
	}

	s->audioSampleRate = 44100;
	s->audioConfig.clear();
	s->audioConfig.push_back(0x12u); // AAC-LC (2), 44100 Hz (4), Stereo (2)
	s->audioConfig.push_back(0x10u);
	s->pcmBytes = 0;
	s->aacReady = true;
	return true;
}

static void Mp4EncodeOneAacFrame(Mp4Session *s, const uint8_t *pcm4096) {
	if (!s || !s->aacReady || !s->aacHandle || !pcm4096)
		return;
	VO_CODECBUFFER input;
	VO_CODECBUFFER output;
	VO_AUDIO_OUTPUTINFO outInfo;
	uint8_t aacOut[8192];

	memset(&input, 0, sizeof(input));
	memset(&output, 0, sizeof(output));
	memset(&outInfo, 0, sizeof(outInfo));

	input.Buffer = (uint8_t *)pcm4096;
	input.Length = 4096;
	if (s->aacApi.SetInputData(s->aacHandle, &input) != VO_ERR_NONE)
		return;

	output.Buffer = aacOut;
	output.Length = sizeof(aacOut);
	if (s->aacApi.GetOutputData(s->aacHandle, &output, &outInfo) != VO_ERR_NONE || output.Length == 0)
		return;

	if (Mp4AppendSamplePayload(s, MP4_TRACK_AUDIO, aacOut, (uint32_t)output.Length)) {
		Mp4AudioSampleMeta am;
		am.size = (uint32_t)output.Length;
		am.durationTicks = 1024u;
		s->audioSamples.push_back(am);
	}
}

static void Mp4CloseAacEncoder(Mp4Session *s, bool flushTail) {
	if (!s || !s->aacReady)
		return;
	if (flushTail && s->pcmBytes > 0 && !s->videoSamples.empty()) {
		memset(s->pcmBuf + s->pcmBytes, 0, 4096 - s->pcmBytes);
		Mp4EncodeOneAacFrame(s, s->pcmBuf);
	}
	s->pcmBytes = 0;
	if (s->aacHandle && s->aacApi.Uninit) {
		s->aacApi.Uninit(s->aacHandle);
	}
	s->aacHandle = 0;
	s->aacReady = false;
}
#endif

static void Mp4WriteEsdsBox(Mp4ByteBuf &buf, const std::vector<uint8_t> &asc, uint32_t maxBitrate, uint32_t avgBitrate) {
	static const uint8_t kDefaultAsc44kStereo[2] = { 0x12, 0x10 };
	const uint8_t *ascPtr = asc.empty() ? kDefaultAsc44kStereo : asc.data();
	uint32_t ascLen = (uint32_t)(asc.empty() ? sizeof(kDefaultAsc44kStereo) : (asc.size() > 64 ? 64 : asc.size()));

	size_t boxPos = buf.beginFullBox("esds", 0, 0);

	// Descriptor sizes using standard 4-byte expandable lengths (matching ffmpeg/ISO 14496-1)
	uint32_t dsiTotal = 1u + 4u + ascLen;
	uint32_t dcdPayload = 13u + dsiTotal;
	uint32_t dcdTotal = 1u + 4u + dcdPayload;
	uint32_t slTotal = 1u + 4u + 1u;
	uint32_t esdPayload = 3u + dcdTotal + slTotal;

	// ES_Descriptor (tag 0x03)
	buf.u8(0x03);
	buf.descrLen(esdPayload);
	buf.u16(2); // ES_ID = 2
	buf.u8(0);  // flags

	// DecoderConfigDescriptor (tag 0x04)
	buf.u8(0x04);
	buf.descrLen(dcdPayload);
	buf.u8(0x40); // MPEG-4 Audio ISO/IEC 14496-3
	buf.u8(0x15); // audioStream (5 << 2) | 1
	buf.u24(0);   // bufferSizeDB
	buf.u32(maxBitrate > 0 ? maxBitrate : 128000u);
	buf.u32(avgBitrate > 0 ? avgBitrate : 128000u);

	// DecoderSpecificInfo (tag 0x05)
	buf.u8(0x05);
	buf.descrLen(ascLen);
	buf.bytes(ascPtr, ascLen);

	// SLConfigDescriptor (tag 0x06)
	buf.u8(0x06);
	buf.descrLen(1u);
	buf.u8(0x02);

	buf.endBox(boxPos);
}

static void Mp4WriteStscFromChunks(Mp4ByteBuf &out, const std::vector<Mp4ChunkRun> &chunks) {
	std::vector<Mp4RlePair> stscEntries;
	for (size_t i = 0; i < chunks.size(); i++) {
		uint32_t spc = chunks[i].sampleCount;
		if (stscEntries.empty() || stscEntries.back().value != spc) {
			Mp4RlePair e;
			e.count = (uint32_t)(i + 1); // 1-based first_chunk
			e.value = spc;               // samples_per_chunk
			stscEntries.push_back(e);
		}
	}
	size_t p = out.beginFullBox("stsc", 0, 0);
	out.u32((uint32_t)stscEntries.size());
	for (size_t i = 0; i < stscEntries.size(); i++) {
		out.u32(stscEntries[i].count);
		out.u32(stscEntries[i].value);
		out.u32(1u); // sample_description_index
	}
	out.endBox(p);
}

static void Mp4BuildFastStartHeader(Mp4Session *s, Mp4ByteBuf &out) {
	out.b.clear();
	if (!s || s->videoSamples.empty() || s->avcC.empty())
		return;

	const bool hasAudio = s->audioEnabled && !s->audioSamples.empty();
	const uint64_t spoolSize = s->spoolBytesWritten;
	const bool useMdat64 = (spoolSize + 8ull) > 0xFFFFFFFFull;
	const uint64_t mdatHdrSize = useMdat64 ? 16ull : 8ull;
	const bool useCo64 = (spoolSize + 16ull * 1024ull * 1024ull) > 0xFFFFFFFFull;

	// Compute video decode durations, B-frame CTS shift, and run-length tables
	const size_t vCount = s->videoSamples.size();
	uint64_t videoDuration90k = 0;
	int64_t minPtsMinusDts = 0;
	std::vector<int64_t> rawCto(vCount, 0);
	uint64_t curDts90k = 0;

	for (size_t i = 0; i < vCount; i++) {
		int64_t diff = s->videoSamples[i].pts90k - (int64_t)curDts90k;
		rawCto[i] = diff;
		if (i == 0 || diff < minPtsMinusDts)
			minPtsMinusDts = diff;
		curDts90k += s->videoSamples[i].duration90k;
	}
	videoDuration90k = curDts90k;
	if (videoDuration90k == 0)
		videoDuration90k = 1500ull;

	uint32_t videoCtsShift90k = (minPtsMinusDts < 0) ? (uint32_t)(-minPtsMinusDts) : 0u;
	bool needCtts = false;
	std::vector<Mp4RlePair> vStts;
	std::vector<Mp4RlePair> vCtts;
	std::vector<uint32_t> vStss;
	uint64_t videoTotalBytes = 0;
	uint32_t videoMaxSampleSize = 0;

	for (size_t i = 0; i < vCount; i++) {
		const Mp4VideoSampleMeta &vm = s->videoSamples[i];
		videoTotalBytes += vm.size;
		if (vm.size > videoMaxSampleSize)
			videoMaxSampleSize = vm.size;

		if (vStts.empty() || vStts.back().value != vm.duration90k) {
			Mp4RlePair r = { 1u, vm.duration90k };
			vStts.push_back(r);
		} else {
			vStts.back().count++;
		}

		uint32_t ucto = (uint32_t)(rawCto[i] + (int64_t)videoCtsShift90k);
		if (ucto != 0)
			needCtts = true;
		if (vCtts.empty() || vCtts.back().value != ucto) {
			Mp4RlePair r = { 1u, ucto };
			vCtts.push_back(r);
		} else {
			vCtts.back().count++;
		}

		if (vm.isKeyframe || i == 0) {
			vStss.push_back((uint32_t)(i + 1)); // 1-based sample number
		}
	}

	uint32_t videoAvgBitrate = (videoDuration90k > 0)
		? (uint32_t)((videoTotalBytes * 8ull * 90000ull) / videoDuration90k)
		: 2000000u;

	// Compute audio timing & run-length tables
	const uint32_t audioSr = (uint32_t)(s->audioSampleRate > 0 ? s->audioSampleRate : 44100);
	uint64_t totalAudioTicks = 0;
	uint64_t audioTotalBytes = 0;
	uint32_t audioMaxSampleSize = 0;
	std::vector<Mp4RlePair> aStts;

	if (hasAudio) {
		for (size_t i = 0; i < s->audioSamples.size(); i++) {
			const Mp4AudioSampleMeta &am = s->audioSamples[i];
			totalAudioTicks += am.durationTicks;
			audioTotalBytes += am.size;
			if (am.size > audioMaxSampleSize)
				audioMaxSampleSize = am.size;
			if (aStts.empty() || aStts.back().value != am.durationTicks) {
				Mp4RlePair r = { 1u, am.durationTicks };
				aStts.push_back(r);
			} else {
				aStts.back().count++;
			}
		}
	}

	uint64_t audioDuration90k = (hasAudio && audioSr > 0)
		? (uint64_t)llround((double)totalAudioTicks * 90000.0 / (double)audioSr)
		: 0ull;
	// Clamp audio presentation duration to video duration if within 1 AAC frame so Discord shows clean clip length
	uint64_t audioTrackDur90k = audioDuration90k;
	if (hasAudio && audioTrackDur90k > videoDuration90k && (audioTrackDur90k - videoDuration90k) <= 4500ull) {
		audioTrackDur90k = videoDuration90k;
	}
	uint64_t movieDuration90k = (hasAudio && audioTrackDur90k > videoDuration90k)
		? audioTrackDur90k
		: videoDuration90k;

	uint32_t audioAvgBitrate = (hasAudio && totalAudioTicks > 0)
		? (uint32_t)((audioTotalBytes * 8ull * (uint64_t)audioSr) / totalAudioTicks)
		: (uint32_t)(s->audioBitrate > 0 ? s->audioBitrate : 128000);

	// 1. ftyp (standard non-fragmented ISO MP4 brands matching ffmpeg -movflags +faststart)
	{
		size_t p = out.beginBox("ftyp");
		out.fourcc("isom");
		out.u32(0x00000200u);
		out.fourcc("isom");
		out.fourcc("iso2");
		out.fourcc("avc1");
		out.fourcc("mp41");
		out.endBox(p);
	}

	size_t videoStcoPos = 0;
	size_t audioStcoPos = 0;

	// 2. moov (at front of file for instant streaming / Discord inline embed)
	{
		size_t moovPos = out.beginBox("moov");

		// mvhd
		{
			size_t p = out.beginFullBox("mvhd", 0, 0);
			out.u32(0); // creation_time
			out.u32(0); // modification_time
			out.u32(90000u); // timescale
			out.u32((uint32_t)movieDuration90k);
			out.u32(0x00010000u); // rate 1.0
			out.u16(0x0100u);     // volume 1.0
			out.zeros(10);
			Mp4WriteUnityMatrix(out);
			out.zeros(24);
			out.u32(hasAudio ? 3u : 2u); // next_track_ID
			out.endBox(p);
		}

		// Video trak (track_ID = 1)
		{
			size_t trakPos = out.beginBox("trak");
			{
				size_t tkhdPos = out.beginFullBox("tkhd", 0, 0x000003u);
				out.u32(0);
				out.u32(0);
				out.u32(1u); // track_ID = 1
				out.u32(0);
				out.u32((uint32_t)videoDuration90k);
				out.zeros(8);
				out.u16(0); // layer
				out.u16(0); // alternate_group
				out.u16(0); // volume = 0 for video
				out.u16(0);
				Mp4WriteUnityMatrix(out);
				out.u32((uint32_t)s->width << 16);
				out.u32((uint32_t)s->height << 16);
				out.endBox(tkhdPos);
			}
			{
				size_t edtsPos = out.beginBox("edts");
				size_t elstPos = out.beginFullBox("elst", 0, 0);
				out.u32(1u);
				out.u32((uint32_t)videoDuration90k);
				out.i32((int32_t)videoCtsShift90k);
				out.u16(1u);
				out.u16(0);
				out.endBox(elstPos);
				out.endBox(edtsPos);
			}
			{
				size_t mdiaPos = out.beginBox("mdia");
				{
					size_t mdhdPos = out.beginFullBox("mdhd", 0, 0);
					out.u32(0);
					out.u32(0);
					out.u32(90000u);
					out.u32((uint32_t)videoDuration90k);
					out.u16(0x55C4u); // "und"
					out.u16(0);
					out.endBox(mdhdPos);
				}
				{
					size_t hdlrPos = out.beginFullBox("hdlr", 0, 0);
					out.u32(0);
					out.fourcc("vide");
					out.zeros(12);
					const char *hname = "VideoHandler";
					out.bytes(hname, strlen(hname) + 1);
					out.endBox(hdlrPos);
				}
				{
					size_t minfPos = out.beginBox("minf");
					{
						size_t vmhdPos = out.beginFullBox("vmhd", 0, 0x000001u);
						out.u16(0);
						out.zeros(6);
						out.endBox(vmhdPos);
					}
					{
						size_t dinfPos = out.beginBox("dinf");
						size_t drefPos = out.beginFullBox("dref", 0, 0);
						out.u32(1u);
						size_t urlPos = out.beginFullBox("url ", 0, 0x000001u);
						out.endBox(urlPos);
						out.endBox(drefPos);
						out.endBox(dinfPos);
					}
					{
						size_t stblPos = out.beginBox("stbl");
						{
							size_t stsdPos = out.beginFullBox("stsd", 0, 0);
							out.u32(1u);
							size_t avc1Pos = out.beginBox("avc1");
							out.zeros(6);
							out.u16(1u); // data_reference_index
							out.zeros(16);
							out.u16((uint16_t)s->width);
							out.u16((uint16_t)s->height);
							out.u32(0x00480000u);
							out.u32(0x00480000u);
							out.u32(0);
							out.u16(1u); // frame_count
							out.zeros(32);
							out.u16(0x0018u);
							out.u16(0xFFFFu);
							{
								size_t avcCPos = out.beginBox("avcC");
								out.bytes(s->avcC.data(), s->avcC.size());
								out.endBox(avcCPos);
							}
							{
								size_t paspPos = out.beginBox("pasp");
								out.u32(1u);
								out.u32(1u);
								out.endBox(paspPos);
							}
							{
								size_t colrPos = out.beginBox("colr");
								out.fourcc("nclx");
								out.u16(1u); // BT.709 primaries
								out.u16(1u); // BT.709 transfer
								out.u16(1u); // BT.709 matrix
								out.u8(0);   // TV/limited range
								out.endBox(colrPos);
							}
							{
								size_t btrtPos = out.beginBox("btrt");
								out.u32(videoMaxSampleSize);
								out.u32(videoAvgBitrate);
								out.u32(videoAvgBitrate);
								out.endBox(btrtPos);
							}
							out.endBox(avc1Pos);
							out.endBox(stsdPos);
						}
						{
							size_t p = out.beginFullBox("stts", 0, 0);
							out.u32((uint32_t)vStts.size());
							for (size_t i = 0; i < vStts.size(); i++) {
								out.u32(vStts[i].count);
								out.u32(vStts[i].value);
							}
							out.endBox(p);
						}
						{
							size_t p = out.beginFullBox("stss", 0, 0);
							out.u32((uint32_t)vStss.size());
							for (size_t i = 0; i < vStss.size(); i++) {
								out.u32(vStss[i]);
							}
							out.endBox(p);
						}
						if (needCtts) {
							size_t p = out.beginFullBox("ctts", 0, 0);
							out.u32((uint32_t)vCtts.size());
							for (size_t i = 0; i < vCtts.size(); i++) {
								out.u32(vCtts[i].count);
								out.u32(vCtts[i].value);
							}
							out.endBox(p);
						}
						Mp4WriteStscFromChunks(out, s->videoChunks);
						{
							size_t p = out.beginFullBox("stsz", 0, 0);
							out.u32(0); // variable sample sizes
							out.u32((uint32_t)vCount);
							for (size_t i = 0; i < vCount; i++) {
								out.u32(s->videoSamples[i].size);
							}
							out.endBox(p);
						}
						if (useCo64) {
							size_t p = out.beginFullBox("co64", 0, 0);
							out.u32((uint32_t)s->videoChunks.size());
							videoStcoPos = out.b.size();
							for (size_t i = 0; i < s->videoChunks.size(); i++) {
								out.u64(0);
							}
							out.endBox(p);
						} else {
							size_t p = out.beginFullBox("stco", 0, 0);
							out.u32((uint32_t)s->videoChunks.size());
							videoStcoPos = out.b.size();
							for (size_t i = 0; i < s->videoChunks.size(); i++) {
								out.u32(0);
							}
							out.endBox(p);
						}
						out.endBox(stblPos);
					}
					out.endBox(minfPos);
				}
				out.endBox(mdiaPos);
			}
			out.endBox(trakPos);
		}

		// Audio trak (track_ID = 2, AAC-LC mp4a.40.2)
		if (hasAudio) {
			size_t trakPos = out.beginBox("trak");
			{
				size_t tkhdPos = out.beginFullBox("tkhd", 0, 0x000003u);
				out.u32(0);
				out.u32(0);
				out.u32(2u); // track_ID = 2
				out.u32(0);
				out.u32((uint32_t)audioTrackDur90k);
				out.zeros(8);
				out.u16(0);
				out.u16(1u); // alternate_group = 1
				out.u16(0x0100u); // volume 1.0
				out.u16(0);
				Mp4WriteUnityMatrix(out);
				out.u32(0);
				out.u32(0);
				out.endBox(tkhdPos);
			}
			{
				size_t edtsPos = out.beginBox("edts");
				size_t elstPos = out.beginFullBox("elst", 0, 0);
				out.u32(1u);
				out.u32((uint32_t)audioTrackDur90k);
				out.i32(0);
				out.u16(1u);
				out.u16(0);
				out.endBox(elstPos);
				out.endBox(edtsPos);
			}
			{
				size_t mdiaPos = out.beginBox("mdia");
				{
					size_t mdhdPos = out.beginFullBox("mdhd", 0, 0);
					out.u32(0);
					out.u32(0);
					out.u32(audioSr);
					out.u32((uint32_t)totalAudioTicks);
					out.u16(0x55C4u); // "und"
					out.u16(0);
					out.endBox(mdhdPos);
				}
				{
					size_t hdlrPos = out.beginFullBox("hdlr", 0, 0);
					out.u32(0);
					out.fourcc("soun");
					out.zeros(12);
					const char *hname = "SoundHandler";
					out.bytes(hname, strlen(hname) + 1);
					out.endBox(hdlrPos);
				}
				{
					size_t minfPos = out.beginBox("minf");
					{
						size_t smhdPos = out.beginFullBox("smhd", 0, 0);
						out.u16(0);
						out.u16(0);
						out.endBox(smhdPos);
					}
					{
						size_t dinfPos = out.beginBox("dinf");
						size_t drefPos = out.beginFullBox("dref", 0, 0);
						out.u32(1u);
						size_t urlPos = out.beginFullBox("url ", 0, 0x000001u);
						out.endBox(urlPos);
						out.endBox(drefPos);
						out.endBox(dinfPos);
					}
					{
						size_t stblPos = out.beginBox("stbl");
						{
							size_t stsdPos = out.beginFullBox("stsd", 0, 0);
							out.u32(1u);
							size_t mp4aPos = out.beginBox("mp4a");
							out.zeros(6);
							out.u16(1u);
							out.zeros(8);
							out.u16(2u);  // stereo
							out.u16(16u); // 16-bit
							out.u16(0);
							out.u16(0);
							out.u32(audioSr << 16);
							Mp4WriteEsdsBox(out, s->audioConfig, audioAvgBitrate, audioAvgBitrate);
							{
								size_t btrtPos = out.beginBox("btrt");
								out.u32(audioMaxSampleSize);
								out.u32(audioAvgBitrate);
								out.u32(audioAvgBitrate);
								out.endBox(btrtPos);
							}
							out.endBox(mp4aPos);
							out.endBox(stsdPos);
						}
						{
							size_t p = out.beginFullBox("stts", 0, 0);
							out.u32((uint32_t)aStts.size());
							for (size_t i = 0; i < aStts.size(); i++) {
								out.u32(aStts[i].count);
								out.u32(aStts[i].value);
							}
							out.endBox(p);
						}
						Mp4WriteStscFromChunks(out, s->audioChunks);
						{
							size_t p = out.beginFullBox("stsz", 0, 0);
							out.u32(0);
							out.u32((uint32_t)s->audioSamples.size());
							for (size_t i = 0; i < s->audioSamples.size(); i++) {
								out.u32(s->audioSamples[i].size);
							}
							out.endBox(p);
						}
						if (useCo64) {
							size_t p = out.beginFullBox("co64", 0, 0);
							out.u32((uint32_t)s->audioChunks.size());
							audioStcoPos = out.b.size();
							for (size_t i = 0; i < s->audioChunks.size(); i++) {
								out.u64(0);
							}
							out.endBox(p);
						} else {
							size_t p = out.beginFullBox("stco", 0, 0);
							out.u32((uint32_t)s->audioChunks.size());
							audioStcoPos = out.b.size();
							for (size_t i = 0; i < s->audioChunks.size(); i++) {
								out.u32(0);
							}
							out.endBox(p);
						}
						out.endBox(stblPos);
					}
					out.endBox(minfPos);
				}
				out.endBox(mdiaPos);
			}
			out.endBox(trakPos);
		}

		out.endBox(moovPos);
	}

	// Patch exact file offsets into stco/co64 now that ftyp + moov byte size is finalized
	const uint64_t mdatPayloadFileOffset = (uint64_t)out.b.size() + mdatHdrSize;
	if (videoStcoPos) {
		for (size_t i = 0; i < s->videoChunks.size(); i++) {
			uint64_t off = mdatPayloadFileOffset + s->videoChunks[i].spoolOffset;
			if (useCo64) out.patchU64(videoStcoPos + i * 8, off);
			else out.patchU32(videoStcoPos + i * 4, (uint32_t)off);
		}
	}
	if (hasAudio && audioStcoPos) {
		for (size_t i = 0; i < s->audioChunks.size(); i++) {
			uint64_t off = mdatPayloadFileOffset + s->audioChunks[i].spoolOffset;
			if (useCo64) out.patchU64(audioStcoPos + i * 8, off);
			else out.patchU32(audioStcoPos + i * 4, (uint32_t)off);
		}
	}

	// 3. mdat box header (payload bytes follow immediately from spool)
	if (useMdat64) {
		out.u32(1u);
		out.fourcc("mdat");
		out.u64(16ull + spoolSize);
	} else {
		out.u32((uint32_t)(8ull + spoolSize));
		out.fourcc("mdat");
	}
}

static void Mp4FinalizeAndClose(Mp4Session *s) {
	if (!s)
		return;

#ifdef __EMSCRIPTEN__
	Mp4CloseAacEncoder(s, true);
#endif

	Mp4ByteBuf hdr;
	Mp4BuildFastStartHeader(s, hdr);

	if (s->pipe) {
#ifdef __EMSCRIPTEN__
		s_mp4EncodedBytes = (double)hdr.b.size() + (double)s->spoolBytesWritten;
		wasm_js_mp4_spool_finalize(
			hdr.b.empty() ? NULL : hdr.b.data(),
			(int)hdr.b.size(),
			(double)s->spoolBytesWritten
		);
#endif
	} else {
		if (s->rawFile) {
			ri.FS_FCloseFile(s->rawFile);
			s->rawFile = 0;
		}
		if (!hdr.b.empty() && s->tempRawName[0]) {
			char outName[MAX_OSPATH];
			Com_sprintf(outName, sizeof(outName), "%s.mp4", s->name[0] ? s->name : "capture");
			fileHandle_t outF = ri.FS_FOpenFileWrite(outName);
			fileHandle_t inF = 0;
			int rawLen = ri.FS_FOpenFileRead(s->tempRawName, &inF, qtrue);
			if (outF) {
				ri.FS_Write(hdr.b.data(), (int)hdr.b.size(), outF);
				if (inF && rawLen > 0) {
					std::vector<uint8_t> copyBuf(65536);
					int rem = rawLen;
					while (rem > 0) {
						int chunk = rem > (int)copyBuf.size() ? (int)copyBuf.size() : rem;
						int got = ri.FS_Read(copyBuf.data(), chunk, inF);
						if (got <= 0)
							break;
						ri.FS_Write(copyBuf.data(), got, outF);
						rem -= got;
					}
				}
				ri.FS_FCloseFile(outF);
			}
			if (inF) {
				ri.FS_FCloseFile(inF);
			}
			s_mp4EncodedBytes = (double)hdr.b.size() + (double)s->spoolBytesWritten;
		}
	}
}

extern "C" {

#ifdef __EMSCRIPTEN__
EMSCRIPTEN_KEEPALIVE
#endif
void MME_Mp4OnVideoPacket(
	intptr_t sessionPtr,
	const uint8_t *data,
	int dataLen,
	int isKeyframe,
	double timestampUs,
	const uint8_t *avcCData,
	int avcCLen
) {
	Mp4Session *s = (Mp4Session *)sessionPtr;
	if (!s || dataLen <= 0 || !data)
		return;
	if (avcCLen > 0 && avcCData && s->avcC.empty()) {
		s->avcC.assign(avcCData, avcCData + avcCLen);
	}

	const uint8_t *payloadPtr = data;
	uint32_t payloadLen = (uint32_t)dataLen;
	std::vector<uint8_t> convertedAvcc;

	if (!Mp4IsValidAvcc(data, (size_t)dataLen)) {
		if (!Mp4ConvertAnnexBToAvcc(data, (size_t)dataLen, convertedAvcc, s->avcC))
			return;
		payloadPtr = convertedAvcc.data();
		payloadLen = (uint32_t)convertedAvcc.size();
	} else if (s->avcC.empty()) {
		Mp4ExtractAvcCFromAvccSample(data, (size_t)dataLen, s->avcC);
	}

	int64_t tsUs = llround(timestampUs);
	if (!s->hasBasePts) {
		s->hasBasePts = true;
		s->basePtsUs = tsUs;
	}
	int64_t relUs = tsUs - s->basePtsUs;
	if (relUs < 0)
		relUs = 0;

	uint64_t idx = (uint64_t)s->videoSamples.size();
	double fps = (s->fps > 1.0f) ? (double)s->fps : 60.0;
	uint64_t dts0 = (uint64_t)llround((double)idx * 90000.0 / fps);
	uint64_t dts1 = (uint64_t)llround((double)(idx + 1) * 90000.0 / fps);
	uint32_t dur90k = (dts1 > dts0) ? (uint32_t)(dts1 - dts0) : 1500u;
	int64_t pts90k = llround((double)relUs * 90000.0 / 1000000.0);

	if (!Mp4AppendSamplePayload(s, MP4_TRACK_VIDEO, payloadPtr, payloadLen))
		return;

	Mp4VideoSampleMeta vm;
	vm.size = payloadLen;
	vm.duration90k = dur90k;
	vm.pts90k = pts90k;
	vm.isKeyframe = (isKeyframe != 0) ? 1u : 0u;
	s->videoSamples.push_back(vm);
}

#ifdef __EMSCRIPTEN__
EMSCRIPTEN_KEEPALIVE
#endif
void MME_Mp4OnAudioPacket(
	intptr_t sessionPtr,
	const uint8_t *data,
	int dataLen,
	int codecType,
	int sampleRate,
	int frameSamples,
	const uint8_t *ascData,
	int ascLen
) {
	(void)codecType;
	Mp4Session *s = (Mp4Session *)sessionPtr;
	if (!s || dataLen <= 0 || !data)
		return;
	if (sampleRate > 0)
		s->audioSampleRate = sampleRate;
	if (ascLen > 0 && ascData && s->audioConfig.empty()) {
		s->audioConfig.assign(ascData, ascData + ascLen);
	}
	if (!Mp4AppendSamplePayload(s, MP4_TRACK_AUDIO, data, (uint32_t)dataLen))
		return;

	Mp4AudioSampleMeta am;
	am.size = (uint32_t)dataLen;
	am.durationTicks = (uint32_t)(frameSamples > 0 ? frameSamples : 1024);
	s->audioSamples.push_back(am);
}

#ifdef __EMSCRIPTEN__
EMSCRIPTEN_KEEPALIVE
#endif
void MME_Mp4FinalizeSession(intptr_t sessionPtr) {
	Mp4Session *s = (Mp4Session *)sessionPtr;
	if (!s) {
		if (s_mp4PendingFlushes > 0)
			s_mp4PendingFlushes--;
		return;
	}
	Mp4FinalizeAndClose(s);
	delete s;
	if (s_mp4PendingFlushes > 0)
		s_mp4PendingFlushes--;
}

} // extern "C"

#ifdef __EMSCRIPTEN__
EM_JS(int, wasm_js_mp4_open, (
	intptr_t sessionPtr,
	int width,
	int height,
	float fps,
	int videoBitrate,
	float maxMegs,
	int crf
), {
	try {
		var g = typeof globalThis !== 'undefined' ? globalThis : (typeof self !== 'undefined' ? self : window);
		if (typeof VideoEncoder === 'undefined') {
			console.error('WebCodecs VideoEncoder is not available in this browser context.');
			return 0;
		}
		if (!g.__jkMp4Encoders) {
			g.__jkMp4Encoders = {};
			g.__jkMp4NextId = 1;
		}
		var id = g.__jkMp4NextId++;
		g.__jkLastEncoderError = '';
		var evenW = Math.max(2, width & ~1);
		var evenH = Math.max(2, height & ~1);
		var caps = g.__jkWebCodecsCaps || null;

		var mbs = Math.ceil(evenW / 16) * Math.ceil(evenH / 16);
		var mbsPerSec = mbs * Math.max(1, fps);
		var levelHex = '2a'; // Level 4.2 (up to 1080p60)
		if (mbs <= 3600 && mbsPerSec <= 108000) levelHex = '1f';
		else if (mbs <= 8192 && mbsPerSec <= 245760) levelHex = '28';
		else if (mbs <= 8192 && mbsPerSec <= 522240) levelHex = '2a';
		else levelHex = '33'; // Level 5.1 (1440p60 / 4K30)

		var codecCandidates = [
			'avc1.6400' + levelHex,
			'avc1.4d00' + levelHex,
			'avc1.4200' + levelHex,
			'avc1.42e0' + levelHex,
			'avc1.640033',
			'avc1.42e02a'
		];
		if (caps && caps.avcPrefix) {
			codecCandidates.unshift(caps.avcPrefix + levelHex);
		}

		var useQuantizer = false;
		var targetBitrate = videoBitrate | 0;
		var clampedCrf = Math.max(10, Math.min(42, crf | 0));
		if (targetBitrate <= 0) {
			if (caps && caps.quantizer) {
				useQuantizer = true;
			} else {
				var bpp = 0.22 * Math.pow(2.0, (18.0 - clampedCrf) / 6.0);
				targetBitrate = Math.round(evenW * evenH * fps * bpp);
				targetBitrate = Math.max(400000, Math.min(45000000, targetBitrate));
			}
		} else {
			targetBitrate = Math.max(200000, Math.min(60000000, targetBitrate));
		}

		var state = {
			id: id,
			sessionPtr: sessionPtr,
			width: evenW,
			height: evenH,
			fps: fps,
			frameIndex: 0,
			keyInterval: Math.max(15, Math.round(fps * 2)),
			useQuantizer: useQuantizer,
			crf: clampedCrf,
			baseBitrate: targetBitrate,
			currentBitrate: targetBitrate,
			maxBytes: maxMegs > 0 ? Math.floor(maxMegs * 1024 * 1024) : 0,
			bytesEmitted: 0,
			chosenVideoConfig: null,
			ve: null
		};

		state.ve = new VideoEncoder({
			output: function(chunk, meta) {
				try {
					var len = chunk.byteLength | 0;
					if (len <= 0) return;
					var dataPtr = _malloc(len);
					chunk.copyTo(HEAPU8.subarray(dataPtr, dataPtr + len));

					var descPtr = 0;
					var descLen = 0;
					if (meta && meta.decoderConfig && meta.decoderConfig.description) {
						var rawDesc = meta.decoderConfig.description;
						var descBytes = rawDesc instanceof Uint8Array
							? rawDesc
							: new Uint8Array(rawDesc.buffer || rawDesc, rawDesc.byteOffset || 0, rawDesc.byteLength || 0);
						if (descBytes.byteLength > 0) {
							descLen = descBytes.byteLength | 0;
							descPtr = _malloc(descLen);
							HEAPU8.set(descBytes, descPtr);
						}
					}

					state.bytesEmitted += len;
					_MME_Mp4OnVideoPacket(
						state.sessionPtr,
						dataPtr,
						len,
						chunk.type === 'key' ? 1 : 0,
						chunk.timestamp || 0,
						descPtr,
						descLen
					);
					if (descPtr) _free(descPtr);
					_free(dataPtr);
				} catch (errOut) {
					console.error('VideoEncoder output callback error:', errOut);
				}
			},
			error: function(err) {
				var msg = String((err && (err.message || err.name)) || err || 'VideoEncoder error');
				g.__jkLastEncoderError = msg;
				state.ve = null;
				console.error('VideoEncoder error:', msg);
			}
		});

		var configuredVideo = false;
		var accelTries = (caps && caps.hwAccel === 'prefer-hardware')
			? ['prefer-hardware', 'no-preference']
			: ['no-preference'];

		for (var ai = 0; ai < accelTries.length && !configuredVideo; ai++) {
			for (var ci = 0; ci < codecCandidates.length && !configuredVideo; ci++) {
				var vcfg = {
					codec: codecCandidates[ci],
					width: evenW,
					height: evenH,
					framerate: fps,
					avc: { format: 'avc' },
					hardwareAcceleration: accelTries[ai]
				};
				if (state.useQuantizer) {
					vcfg.bitrateMode = 'quantizer';
				} else {
					vcfg.bitrate = state.currentBitrate;
					vcfg.bitrateMode = state.maxBytes > 0 ? 'constant' : 'variable';
				}
				try {
					state.ve.configure(vcfg);
					state.chosenVideoConfig = vcfg;
					configuredVideo = true;
				} catch (eCfg) {
					if (!state.useQuantizer && vcfg.bitrateMode === 'constant') {
						try {
							vcfg.bitrateMode = 'variable';
							state.ve.configure(vcfg);
							state.chosenVideoConfig = vcfg;
							configuredVideo = true;
						} catch (eCfgVbr) {}
					} else if (state.useQuantizer) {
						try {
							state.useQuantizer = false;
							var bppFb = 0.22 * Math.pow(2.0, (18.0 - clampedCrf) / 6.0);
							state.baseBitrate = state.currentBitrate = Math.max(400000, Math.min(45000000, Math.round(evenW * evenH * fps * bppFb)));
							delete vcfg.bitrateMode;
							vcfg.bitrate = state.currentBitrate;
							state.ve.configure(vcfg);
							state.chosenVideoConfig = vcfg;
							configuredVideo = true;
						} catch (eCfg2) {}
					}
				}
			}
		}

		if (!configuredVideo) {
			console.error('Failed to configure WebCodecs VideoEncoder for', evenW, 'x', evenH);
			try { state.ve.close(); } catch (e0) {}
			return 0;
		}

		g.__jkMp4Encoders[id] = state;
		return id;
	} catch (e) {
		console.error('wasm_js_mp4_open exception:', e);
		return 0;
	}
});

EM_JS(void, wasm_js_mp4_encode_frame, (int encoderId), {
	try {
		var g = typeof globalThis !== 'undefined' ? globalThis : (typeof self !== 'undefined' ? self : window);
		var state = g && g.__jkMp4Encoders ? g.__jkMp4Encoders[encoderId] : null;
		if (!state || !state.ve || state.ve.state !== 'configured') return;
		var canvas = (typeof GLctx !== 'undefined' && GLctx && GLctx.canvas)
			? GLctx.canvas
			: (typeof Module !== 'undefined' ? Module.canvas : null);
		if (!canvas) return;

		var idx = state.frameIndex++;
		var tsUs = Math.round(idx * 1000000.0 / state.fps);
		var nextTsUs = Math.round((idx + 1) * 1000000.0 / state.fps);
		var durUs = Math.max(1, nextTsUs - tsUs);
		var isKey = (idx % state.keyInterval) === 0;

		var vfOpts = { timestamp: tsUs, duration: durUs };
		if (canvas.width !== state.width || canvas.height !== state.height) {
			vfOpts.visibleRect = {
				x: 0,
				y: 0,
				width: Math.min(state.width, canvas.width),
				height: Math.min(state.height, canvas.height)
			};
		}
		var vf = new VideoFrame(canvas, vfOpts);
		try {
			var encOpts = { keyFrame: isKey };
			if (state.useQuantizer) {
				var qp = isKey ? Math.max(10, state.crf - 2) : state.crf;
				encOpts.avc = { quantizer: qp };
			}
			state.ve.encode(vf, encOpts);
		} finally {
			vf.close();
		}
	} catch (e) {
		console.error('wasm_js_mp4_encode_frame error:', e);
	}
});

EM_JS(void, wasm_js_mp4_close, (int encoderId, intptr_t sessionPtr), {
	try {
		var g = typeof globalThis !== 'undefined' ? globalThis : (typeof self !== 'undefined' ? self : window);
		var state = g && g.__jkMp4Encoders ? g.__jkMp4Encoders[encoderId] : null;
		if (!state) {
			_MME_Mp4FinalizeSession(sessionPtr);
			return;
		}
		delete g.__jkMp4Encoders[encoderId];

		var flushPromise = (state.ve && state.ve.state === 'configured')
			? state.ve.flush().catch(function(e) { console.warn('ve.flush error:', e); })
			: Promise.resolve();

		flushPromise.finally(function() {
			try { if (state.ve && state.ve.state !== 'closed') state.ve.close(); } catch (e0) {}
			try {
				_MME_Mp4FinalizeSession(sessionPtr);
			} catch (eFin) {
				console.error('_MME_Mp4FinalizeSession failed:', eFin);
			}
		});
	} catch (e) {
		console.error('wasm_js_mp4_close exception:', e);
		_MME_Mp4FinalizeSession(sessionPtr);
	}
});

EM_JS(int, wasm_js_mp4_get_queue_size, (), {
	try {
		var g = typeof globalThis !== 'undefined' ? globalThis : (typeof self !== 'undefined' ? self : window);
		if (!g || !g.__jkMp4Encoders) return 0;
		var maxQ = 0;
		var keys = Object.keys(g.__jkMp4Encoders);
		for (var i = 0; i < keys.length; i++) {
			var st = g.__jkMp4Encoders[keys[i]];
			if (st && st.ve && typeof st.ve.encodeQueueSize === 'number') {
				if (st.ve.encodeQueueSize > maxQ) maxQ = st.ve.encodeQueueSize;
			}
		}
		return maxQ | 0;
	} catch (e) {}
	return 0;
});
#endif // __EMSCRIPTEN__

void mmeMp4Shot(
	mmeMp4File_t *mp4File,
	const char *name,
	int width,
	int height,
	float fps,
	const byte *inBuf,
	qboolean audio
) {
	(void)inBuf;
	if (!mp4File)
		return;

#ifdef __EMSCRIPTEN__
	Mp4Session *s = (Mp4Session *)mp4File->session;
	if (s && (s->width != width || s->height != height || Q_stricmp(mp4File->name, name))) {
		mp4Close(mp4File);
		s = NULL;
	}
	if (!s) {
		s_mp4CapturedFrames = 0;
		s_mp4EncodedBytes = 0.0;

		s = new Mp4Session();
		Q_strncpyz(s->name, name ? name : "capture", sizeof(s->name));
		Q_strncpyz(mp4File->name, s->name, sizeof(mp4File->name));
		s->pipe = mp4File->pipe;
		s->audioEnabled = audio;
		s->width = width & ~1;
		s->height = height & ~1;
		s->fps = fps > 0.0f ? fps : 60.0f;
		s->audioBitrate = mme_mp4AudioBitrate ? mme_mp4AudioBitrate->integer : 128000;

		if (!Mp4EnsureSpoolOpen(s)) {
			delete s;
			return;
		}
		if (audio) {
			Mp4InitAacEncoder(s);
		}

		int encId = wasm_js_mp4_open(
			(intptr_t)s,
			s->width,
			s->height,
			s->fps,
			mme_mp4Bitrate ? mme_mp4Bitrate->integer : 0,
			mme_mp4MaxMegs ? mme_mp4MaxMegs->value : 0.0f,
			mme_mp4Crf ? mme_mp4Crf->integer : 20
		);
		if (!encId) {
			Mp4CloseAacEncoder(s, false);
			if (s->rawFile) {
				ri.FS_FCloseFile(s->rawFile);
				s->rawFile = 0;
			}
			delete s;
			return;
		}
		s->jsEncoderId = encId;
		mp4File->session = s;
		mp4File->width = s->width;
		mp4File->height = s->height;
		mp4File->fps = s->fps;
		mp4File->audio = audio;
		mp4File->f = 1;
	}

	wasm_js_mp4_encode_frame(s->jsEncoderId);
	s_mp4CapturedFrames++;
#else
	(void)name; (void)width; (void)height; (void)fps; (void)audio;
#endif
}

void mmeMp4Sound(mmeMp4File_t *mp4File, const byte *soundBuf, int size) {
	if (!mp4File || !mp4File->session || !soundBuf || size <= 0)
		return;
#ifdef __EMSCRIPTEN__
	Mp4Session *s = (Mp4Session *)mp4File->session;
	if (!s->audioEnabled || !s->aacReady)
		return;

	int offset = 0;
	while (offset < size) {
		int space = 4096 - s->pcmBytes;
		int take = (size - offset < space) ? (size - offset) : space;
		memcpy(s->pcmBuf + s->pcmBytes, soundBuf + offset, (size_t)take);
		s->pcmBytes += take;
		offset += take;
		if (s->pcmBytes == 4096) {
			Mp4EncodeOneAacFrame(s, s->pcmBuf);
			s->pcmBytes = 0;
		}
	}
#endif
}

void mp4Close(mmeMp4File_t *mp4File) {
	if (!mp4File || !mp4File->session)
		return;
	Mp4Session *s = (Mp4Session *)mp4File->session;
#ifdef __EMSCRIPTEN__
	if (s->audioEnabled && s->aacReady && ri.S_MMEAviImport) {
		byte tailSound[MME_SAMPLERATE] = {0};
		int tailSize = 0;
		if (ri.S_MMEAviImport(tailSound, &tailSize) && tailSize > 0) {
			mmeMp4Sound(mp4File, tailSound, tailSize);
		}
	}
#endif
	mp4File->session = NULL;
	mp4File->f = 0;
	mp4File->pipe = qfalse;
	mp4File->name[0] = '\0';

#ifdef __EMSCRIPTEN__
	if (s->jsEncoderId > 0) {
		s_mp4PendingFlushes++;
		wasm_js_mp4_close(s->jsEncoderId, (intptr_t)s);
		return;
	}
#endif
	Mp4FinalizeAndClose(s);
	delete s;
}

int R_MME_GetMp4CapturedFrames(void) {
	return s_mp4CapturedFrames;
}

double R_MME_GetMp4EncodedBytes(void) {
	return s_mp4EncodedBytes;
}

int R_MME_IsMp4FlushPending(void) {
	return s_mp4PendingFlushes > 0 ? 1 : 0;
}

int R_MME_GetWebCodecsQueueSize(void) {
#ifdef __EMSCRIPTEN__
	return wasm_js_mp4_get_queue_size();
#else
	return 0;
#endif
}
