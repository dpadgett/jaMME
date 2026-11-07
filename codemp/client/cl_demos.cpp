// Copyright (C) 2006 Sjoerd van der Berg
//
// cl_demos.c -- Enhanced demo player and server demo recorder

#include "client.h"
#include "../server/server.h"
#include "cl_demos.h"
#include "../qcommon/game_version.h"

demo_t demo;
static entityState_t	demoNullEntityState;
static playerState_t	demoNullPlayerState;
static entityState_t	s_mmeEntityBaselines[MAX_GENTITIES];

#ifdef __EMSCRIPTEN__
#include <emscripten.h>
extern qboolean g_msgRawBitstream;
static qboolean s_mmeStreamActive = qfalse;
static int s_mmeStreamFileSize = 0;

EM_JS(int, wasm_js_mme_read, (int pos, void *dst, int len), {
	if (typeof window !== 'undefined' && typeof window.__jkMmeRead === 'function') {
		return window.__jkMmeRead(pos, dst, len) | 0;
	}
	return 0;
});
#endif

static const char *demoHeader = JK_VERSION " Demo";

static void demoFrameAddString( demoString_t *string, int num, const char *newString) {
	int			dataLeft, len;
	int			i;
	char		cache[sizeof(string->data)];

	if (!newString[0]) {
		string->offsets[num] = 0;
		return;
	}
	len = strlen( newString ) + 1;
	dataLeft = sizeof(string->data) - string->used;
	if (len <= dataLeft) {
		Com_Memcpy( string->data + string->used, newString, len );
		string->offsets[num] = string->used;
		string->used += len;
		return;
	}
	cache[0] = 0;
	string->used = 1;
	for ( i = 0 ; i < MAX_CONFIGSTRINGS ; i++ ) {
		const char * s;
		s = (i == num) ? newString : string->data + string->offsets[i];
		if (!s[0]) {
			string->offsets[i] = 0;
			continue;
		}
		dataLeft = sizeof(cache) - string->used;
		len = strlen( s ) + 1;
		if ( len >= dataLeft) {
			Com_Printf( "Adding configstring %i with %s overflowed buffer", i, s );
			return;
		}
		Com_Memcpy( cache + string->used, s, len );
		string->offsets[i] = string->used;
		string->used += len;
	}
	Com_Memcpy( string->data, cache, string->used );
}

static void demoFrameUnpack( msg_t *msg, demoFrame_t *oldFrame, demoFrame_t *newFrame, qboolean *firstPack ) {
	int last;
	int areaUsed, commandUsed;
	if ( !msg || !newFrame ) {
		return;
	}
	qboolean isDelta = MSG_ReadBits( msg, 1 ) ? qfalse : qtrue;
	if (!isDelta || !oldFrame) {
		isDelta = qfalse;
		oldFrame = 0;
	}

	newFrame->serverTime = MSG_ReadLong( msg );
	/* Read config strings */
	newFrame->string.data[0] = 0;
	newFrame->string.used = 1;
	last = 0;
	/* Extract config strings */
	while ( 1 ) {
		if ( msg->bit > ( msg->cursize << 3 ) ) {
			Com_Error( ERR_DROP, "demoFrameUnpack: truncated configstrings\n" );
		}
		int i, num = MSG_ReadShort( msg );
		if ( num < last || num > MAX_CONFIGSTRINGS ) {
			Com_Error( ERR_DROP, "demoFrameUnpack: invalid configstring index %d (last=%d)\n", num, last );
		}
		if (!isDelta ) {
			for (i = last;i<num;i++)
				newFrame->string.offsets[i] = 0;
		} else {
			for (i = last;i<num;i++)
				demoFrameAddString( &newFrame->string, i, oldFrame->string.data + oldFrame->string.offsets[i] );
		}
		if (num < MAX_CONFIGSTRINGS) {
			demoFrameAddString( &newFrame->string, num, MSG_ReadBigString( msg ) );
		} else {
			break;
		}
		last = num + 1;
	}
    /* Extract player states */
	Com_Memset( newFrame->clientData, 0, sizeof( newFrame->clientData ));
	last = MSG_ReadByte( msg );
	while (last >= 0 && last < MAX_CLIENTS) {
		playerState_t *oldPlayer, *newPlayer;
		playerState_t *oldVeh, *newVeh;
		newFrame->clientData[last] = 1;
		oldPlayer = isDelta && oldFrame->clientData[last] ? &oldFrame->clients[last] : &demoNullPlayerState;
		newPlayer = &newFrame->clients[last];
		MSG_ReadDeltaPlayerstate( msg, oldPlayer, newPlayer );
		if (newPlayer->m_iVehicleNum) {
			oldVeh = isDelta && oldFrame->clientData[last] ? &oldFrame->vehs[last] : &demoNullPlayerState;
			newVeh = &newFrame->vehs[last];
			MSG_ReadDeltaPlayerstate( msg, oldVeh, newVeh, qtrue );
		}
		last = MSG_ReadByte( msg );
	}
	if ( last != MAX_CLIENTS ) {
		Com_Error( ERR_DROP, "demoFrameUnpack: invalid client index %d\n", last );
	}
	/* Extract entity states */
	last = 0;
	while ( 1 ) {
		if ( msg->bit > ( msg->cursize << 3 ) ) {
			Com_Error( ERR_DROP, "demoFrameUnpack: truncated entities\n" );
		}
		int i, num = MSG_ReadBits( msg, GENTITYNUM_BITS );
		entityState_t *oldEntity, *newEntity;	
		if ( num < last || num >= MAX_GENTITIES ) {
			Com_Error( ERR_DROP, "demoFrameUnpack: invalid entity index %d (last=%d)\n", num, last );
		}
		if ( isDelta ) {
			for (i = last;i<num;i++)
				if (oldFrame->entities[i].number == i)
					newFrame->entities[i] = oldFrame->entities[i];
				else
					newFrame->entities[i].number = MAX_GENTITIES - 1;
		} else {
			for (i = last;i<num;i++)
				newFrame->entities[i].number = MAX_GENTITIES - 1;
		}
		if (num < MAX_GENTITIES - 1) {
			if (isDelta) {
				oldEntity = &oldFrame->entities[num];
				if (oldEntity->number != num)
					oldEntity = &demoNullEntityState;
			} else {
				oldEntity = &demoNullEntityState;
			}
			newEntity = &newFrame->entities[num];
			MSG_ReadDeltaEntity( msg, oldEntity, newEntity, num );
		} else
			break;
		last = num + 1;
	}
	/* Read the area mask */
	areaUsed = MSG_ReadByte( msg );
	if ( areaUsed < 0 || areaUsed > (int)sizeof( newFrame->areamask ) ) {
		Com_Error( ERR_DROP, "demoFrameUnpack: invalid areaUsed %d\n", areaUsed );
	}
	newFrame->areaUsed = areaUsed;
	MSG_ReadData( msg, newFrame->areamask, newFrame->areaUsed );
	/* Read the command string data */
	commandUsed = MSG_ReadLong( msg );
	if ( commandUsed < 0 || commandUsed > (int)sizeof( newFrame->commandData ) ) {
		Com_Error( ERR_DROP, "demoFrameUnpack: invalid commandUsed %d\n", commandUsed );
	}
	newFrame->commandUsed = commandUsed;
	MSG_ReadData( msg, newFrame->commandData, newFrame->commandUsed );
	/* Extract the entity baselines */
	if ( *firstPack ) {
		Com_Memset( s_mmeEntityBaselines, 0, sizeof( s_mmeEntityBaselines ) );
	}
	while ( *firstPack ) {
		byte cmd = MSG_ReadByte( msg );
		if (cmd == svc_EOF)
			break;
		if (cmd == svc_baseline) {
			int num = MSG_ReadBits( msg, GENTITYNUM_BITS );
			if ( num < 0 || num >= MAX_GENTITIES ) {
				Com_Error( ERR_DROP, "Baseline number out of range: %i.\n", num );
			} else {
				entityState_t *newEntity = &newFrame->entityBaselines[num];
				MSG_ReadDeltaEntity( msg, &demoNullEntityState, newEntity, num );
				s_mmeEntityBaselines[num] = *newEntity;
			}
		} else {
			Com_Error( ERR_DROP, "Unknown block %d while unpacking demo frame.\n", cmd );
		}
	}
	*firstPack = qfalse;
}

static void demoFramePack( msg_t *msg, const demoFrame_t *newFrame, const demoFrame_t *oldFrame, qboolean *firstPack ) {
	int i;
	/* Full or delta frame marker */
	MSG_WriteBits( msg, oldFrame ? 0 : 1, 1 );
	MSG_WriteLong( msg, newFrame->serverTime );
	/* Add the config strings */
	if ( !oldFrame || oldFrame->string.used != newFrame->string.used
		|| memcmp( oldFrame->string.offsets, newFrame->string.offsets, sizeof( oldFrame->string.offsets ) )
		|| memcmp( oldFrame->string.data, newFrame->string.data, newFrame->string.used ) ) {
		for (i = 0;i<MAX_CONFIGSTRINGS;i++) {
			if ( (!oldFrame || !oldFrame->string.offsets[i]) && !newFrame->string.offsets[i] ) {
				continue;
			}
			const char *oldString = !oldFrame ? "" : &oldFrame->string.data[oldFrame->string.offsets[i]];
			const char *newString = newFrame->string.data + newFrame->string.offsets[i];
			if (strcmp( oldString, newString)) {
				MSG_WriteShort( msg, i );
				MSG_WriteBigString( msg, newString );
			}
		}
	}
	MSG_WriteShort( msg, MAX_CONFIGSTRINGS );
	/* Add the playerstates */
	for (i=0; i<MAX_CLIENTS; i++) {
		const playerState_t *oldPlayer, *newPlayer;
		const playerState_t *oldVeh, *newVeh;
		if (!newFrame->clientData[i])
			continue;
		oldPlayer = (!oldFrame || !oldFrame->clientData[i]) ? &demoNullPlayerState : &oldFrame->clients[i];
		newPlayer = &newFrame->clients[i];
		MSG_WriteByte( msg, i );
		MSG_WriteDeltaPlayerstate( msg, (playerState_t *)oldPlayer, (playerState_t *)newPlayer );
		if (newPlayer->m_iVehicleNum) {
			oldVeh = (!oldFrame || !oldFrame->clientData[i]) ? &demoNullPlayerState : &oldFrame->vehs[i];
			newVeh = &newFrame->vehs[i];
			MSG_WriteDeltaPlayerstate( msg, (playerState_t *)oldVeh, (playerState_t *)newVeh, qtrue );
		}
	}
	MSG_WriteByte( msg, MAX_CLIENTS );
	/* Add the entities */
	for (i=0; i<MAX_GENTITIES-1; i++) {
		const entityState_t *oldEntity, *newEntity;
		newEntity = &newFrame->entities[i];
		if (oldFrame) {
			oldEntity = &oldFrame->entities[i];
			if (oldEntity->number == (MAX_GENTITIES -1))
				oldEntity = 0;
		} else {
			oldEntity = 0;
		}
		if (newEntity->number != i || newEntity->number >= (MAX_GENTITIES -1)) {
			newEntity = 0;
		} else {
			if (!oldEntity) {
				oldEntity = &demoNullEntityState;
			}
		}
		if ( !oldEntity && !newEntity ) {
			continue;
		}
		if ( oldEntity && newEntity && oldEntity != &demoNullEntityState && !memcmp( oldEntity, newEntity, sizeof( entityState_t ) ) ) {
			continue;
		}
		MSG_WriteDeltaEntity( msg, (entityState_t *)oldEntity, (entityState_t *)newEntity, (qboolean)(oldEntity == &demoNullEntityState) );
	}
	MSG_WriteBits( msg, (MAX_GENTITIES-1), GENTITYNUM_BITS );
	/* Add the area mask */
	MSG_WriteByte( msg, newFrame->areaUsed );
	MSG_WriteData( msg, newFrame->areamask, newFrame->areaUsed );
	/* Add the command string data */
	MSG_WriteLong( msg, newFrame->commandUsed );
	MSG_WriteData( msg, newFrame->commandData, newFrame->commandUsed );
	/* Add the entity baselines */
	if (*firstPack) {
		for (i=0; i<MAX_GENTITIES; i++) {
			const entityState_t *newEntity = &newFrame->entityBaselines[i];
			if ( !newEntity->number ) {
				continue;
			}
			MSG_WriteByte ( msg, svc_baseline );
			MSG_WriteDeltaEntity( msg, &demoNullEntityState, (entityState_t *)newEntity, qtrue );
		}
		MSG_WriteByte( msg, svc_EOF ); //using it for correct break in unpack
		*firstPack = qfalse;
	}
}

static void demoFrameInterpolate( demoFrame_t frames[], int frameCount, int index ) {
	int i;
	demoFrame_t *workFrame;

	workFrame = &frames[index % frameCount];
//	return;

	for (i=0; i<MAX_CLIENTS; i++) {
		entityState_t *workEntity;
		workEntity = &workFrame->entities[i];
		if (workEntity->number != ENTITYNUM_NONE && !workFrame->entityData[i]) {
			int m;
			demoFrame_t *prevFrame, *nextFrame;
			prevFrame = nextFrame = 0;
			for (m = index - 1; (m > (index - frameCount)) && m >0 ; m--) {
				demoFrame_t *testFrame = &frames[ m % frameCount];
				if ( !testFrame->entityData[i])
					continue;
				if (!testFrame->serverTime || testFrame->serverTime >= workFrame->serverTime)
					break;
				if ( testFrame->entities[i].number != i)
					break;
				if ( (testFrame->entities[i].eFlags ^ workEntity->eFlags) & EF_TELEPORT_BIT )
					break;
				prevFrame = testFrame;
				break;
			}
			for (m = index + 1; (m < (index + frameCount)); m++) {
				demoFrame_t *testFrame = &frames[ m % frameCount];
				if ( !testFrame->entityData[i])
					continue;
				if (!testFrame->serverTime || testFrame->serverTime <= workFrame->serverTime)
					break;
				if ( testFrame->entities[i].number != i)
					break;
				if ( (testFrame->entities[i].eFlags ^ workEntity->eFlags) & EF_TELEPORT_BIT )
					break;
				nextFrame = testFrame;
				break;
			}
			if (prevFrame && nextFrame) {
				const entityState_t *prevEntity = &prevFrame->entities[i];
				const entityState_t *nextEntity = &nextFrame->entities[i];
				float lerp;
				int posDelta;
				float posLerp;
				int	 prevTime, nextTime;
                  
				prevTime = prevFrame->serverTime;
				nextTime = nextFrame->serverTime;
				lerp = (workFrame->serverTime - prevTime) / (float)( nextTime - prevTime );
				posDelta = nextEntity->pos.trTime - prevEntity->pos.trTime;
				if ( posDelta ) {
					workEntity->pos.trTime = prevEntity->pos.trTime + posDelta * lerp;
					posLerp = (workEntity->pos.trTime - prevEntity->pos.trTime) / (float) posDelta;
				} else {
					posLerp = lerp;
				}
				LerpOrigin( prevEntity->pos.trBase, nextEntity->pos.trBase, workEntity->pos.trBase, posLerp );
				LerpOrigin( prevEntity->pos.trDelta, nextEntity->pos.trDelta, workEntity->pos.trDelta, posLerp );

				LerpAngles( prevEntity->apos.trBase, nextEntity->apos.trBase, workEntity->apos.trBase, lerp );
			}
		}
	}
}

typedef struct {
	qboolean	valid;
	char		fileName[MAX_OSPATH];
	int			fileSize;
	int			totalFrames;
	int			startTime;
	int			endTime;
	int			fileIndexCount;
	struct {
		int		pos, time, frame;
	} fileIndex[DEMO_MAX_INDEX];
} cachedMmeIndex_t;

static cachedMmeIndex_t s_cachedMmeIndex;

extern "C" qboolean demoIsMmeStreamActive( void ) {
#ifdef __EMSCRIPTEN__
	return s_mmeStreamActive;
#else
	return qfalse;
#endif
}

extern "C" void demoSetMmeStream( qboolean active, const char *fileName, int fileSize, int startTime, int endTime, int totalFrames, int indexCount, const int *indexTriples ) {
#ifdef __EMSCRIPTEN__
	s_mmeStreamActive = active;
	s_mmeStreamFileSize = fileSize;
	if ( active && fileSize > 0 ) {
		s_cachedMmeIndex.valid = qtrue;
		Q_strncpyz( s_cachedMmeIndex.fileName, ( fileName && fileName[0] ) ? fileName : "mmedemos/current.0.mme", sizeof( s_cachedMmeIndex.fileName ) );
		s_cachedMmeIndex.fileSize = fileSize;
		s_cachedMmeIndex.startTime = startTime;
		s_cachedMmeIndex.endTime = endTime;
		s_cachedMmeIndex.totalFrames = totalFrames;
		if ( indexCount < 0 ) indexCount = 0;
		if ( indexCount > DEMO_MAX_INDEX ) indexCount = DEMO_MAX_INDEX;
		s_cachedMmeIndex.fileIndexCount = indexCount;
		if ( indexTriples ) {
			for ( int i = 0; i < indexCount; i++ ) {
				s_cachedMmeIndex.fileIndex[i].pos = indexTriples[i * 3 + 0];
				s_cachedMmeIndex.fileIndex[i].time = indexTriples[i * 3 + 1];
				s_cachedMmeIndex.fileIndex[i].frame = indexTriples[i * 3 + 2];
			}
		}
	} else {
		s_cachedMmeIndex.valid = qfalse;
	}
#else
	(void)active; (void)fileName; (void)fileSize; (void)startTime; (void)endTime; (void)totalFrames; (void)indexCount; (void)indexTriples;
#endif
}

extern "C" qboolean demoReadStreamInitialGamestate( gameState_t *outGs ) {
#ifdef __EMSCRIPTEN__
	if ( !s_mmeStreamActive || !outGs ) {
		return qfalse;
	}
	int hdrLen = (int)strlen( demoHeader );
	if ( wasm_js_mme_read( 0, demo.buffer, hdrLen ) != hdrLen ) {
		return qfalse;
	}
	if ( Q_strncmp( (const char *)demo.buffer, demoHeader, hdrLen ) ) {
		return qfalse;
	}
	int blockSize = 0;
	if ( wasm_js_mme_read( hdrLen, &blockSize, 4 ) != 4 ) {
		return qfalse;
	}
	blockSize = LittleLong( blockSize );
	if ( blockSize <= 0 || blockSize > (int)sizeof( demo.buffer ) ) {
		return qfalse;
	}
	if ( wasm_js_mme_read( hdrLen + 4, demo.buffer, blockSize ) != blockSize ) {
		return qfalse;
	}
	Com_Memset( outGs, 0, sizeof( *outGs ) );
	outGs->dataCount = 1;
	msg_t msg;
	MSG_Init( &msg, demo.buffer, sizeof( demo.buffer ) );
	MSG_BeginReading( &msg );
	msg.cursize = blockSize;
	g_msgRawBitstream = qtrue;
	(void)MSG_ReadBits( &msg, 1 );
	(void)MSG_ReadLong( &msg );
	while ( 1 ) {
		int num = MSG_ReadShort( &msg );
		if ( num < 0 || num >= MAX_CONFIGSTRINGS ) {
			break;
		}
		char *csStr = MSG_ReadBigString( &msg );
		if ( csStr && csStr[0] ) {
			int len = (int)strlen( csStr );
			if ( outGs->dataCount + len + 1 < MAX_GAMESTATE_CHARS ) {
				outGs->stringOffsets[num] = outGs->dataCount;
				Com_Memcpy( outGs->stringData + outGs->dataCount, csStr, (size_t)len + 1 );
				outGs->dataCount += len + 1;
			}
		}
	}
	g_msgRawBitstream = qfalse;
	return qtrue;
#else
	(void)outGs;
	return qfalse;
#endif
}

typedef struct {
	qboolean		active;
	fileHandle_t	oldHandle;
	fileHandle_t	newHandle;
	int				oldSize;
	int				initialSize;
	int				msgSequence;
	int				oldTime;
	int				fullTime;
	int				clientNum;
	int				parseEntitiesNum;
	demoConvert_t	*convert;
	char			bigConfigString[BIG_INFO_STRING];
	int				bigConfigNumber;
	int				levelCount;
	char			newBaseName[MAX_OSPATH];
	char			newName[MAX_OSPATH];
	qboolean		smoothen;
} demoConvertState_t;

static demoConvertState_t s_demoConvertState;

extern qboolean g_msgRawBitstream;

static void demoConvertEmitFrame( fileHandle_t newHandle, const demoFrame_t *newFrame, const demoFrame_t *oldFrame, qboolean trackCache ) {
	msg_t writeMsg;
	int temp;
	MSG_Init( &writeMsg, demo.buffer, sizeof( demo.buffer ) );
	MSG_Clear( &writeMsg );
	MSG_Bitstream( &writeMsg );
#ifdef __EMSCRIPTEN__
	g_msgRawBitstream = qtrue;
#endif
	demoFramePack( &writeMsg, newFrame, oldFrame, &demo.firstPack );
#ifdef __EMSCRIPTEN__
	g_msgRawBitstream = qfalse;
#endif
	if ( trackCache ) {
		if ( !s_cachedMmeIndex.startTime ) {
			s_cachedMmeIndex.startTime = newFrame->serverTime;
		}
		if ( !oldFrame && s_cachedMmeIndex.fileIndexCount < DEMO_MAX_INDEX ) {
			s_cachedMmeIndex.fileIndex[s_cachedMmeIndex.fileIndexCount].pos = s_cachedMmeIndex.fileSize;
			s_cachedMmeIndex.fileIndex[s_cachedMmeIndex.fileIndexCount].frame = s_cachedMmeIndex.totalFrames;
			s_cachedMmeIndex.fileIndex[s_cachedMmeIndex.fileIndexCount].time = newFrame->serverTime;
			s_cachedMmeIndex.fileIndexCount++;
		}
		s_cachedMmeIndex.endTime = newFrame->serverTime;
		s_cachedMmeIndex.fileSize += 4 + writeMsg.cursize;
		s_cachedMmeIndex.totalFrames++;
	}
	temp = LittleLong( writeMsg.cursize );
	FS_Write( &temp, 4, newHandle );
	FS_Write( writeMsg.data, writeMsg.cursize, newHandle );
}

static void demoConvertCleanup( void ) {
	if ( s_demoConvertState.oldHandle ) {
		FS_FCloseFile( s_demoConvertState.oldHandle );
		s_demoConvertState.oldHandle = 0;
	}
	if ( s_demoConvertState.newHandle ) {
		FS_FCloseFile( s_demoConvertState.newHandle );
		s_demoConvertState.newHandle = 0;
	}
	if ( s_demoConvertState.convert ) {
		Z_Free( s_demoConvertState.convert );
		s_demoConvertState.convert = 0;
	}
	s_demoConvertState.active = qfalse;
}

extern "C" void demoConvertAbort( void ) {
	demoConvertCleanup();
}

qboolean demoConvertBegin( const char *oldName, const char *newBaseName, qboolean smoothen ) {
	demoConvertCleanup();
	Com_Memset( &s_demoConvertState, 0, sizeof( s_demoConvertState ) );
	Com_Memset( &s_cachedMmeIndex, 0, sizeof( s_cachedMmeIndex ) );

	s_demoConvertState.oldSize = FS_FOpenFileRead( oldName, &s_demoConvertState.oldHandle, qtrue );
	if ( !s_demoConvertState.oldHandle ) {
		Com_Printf( "Failed to open %s for conversion.\n", oldName );
		return qfalse;
	}
	s_demoConvertState.initialSize = s_demoConvertState.oldSize;
	s_demoConvertState.smoothen = smoothen;
	Q_strncpyz( s_demoConvertState.newBaseName, newBaseName, sizeof( s_demoConvertState.newBaseName ) );
	demo.firstPack = qtrue;
	s_demoConvertState.convert = (demoConvert_t *)Z_Malloc( sizeof( demoConvert_t ), TAG_GENERAL );
	memset( s_demoConvertState.convert, 0, sizeof( demoConvert_t ) );
	s_demoConvertState.active = qtrue;
	Com_SetLoadingMsg( "Converting the demo..." );
	return qtrue;
}

void demoConvertGetProgress( int *outDoneBytes, int *outTotalBytes ) {
	int total = s_demoConvertState.initialSize;
	int rem = s_demoConvertState.oldSize;
	if ( rem < 0 ) rem = 0;
	if ( rem > total ) rem = total;
	if ( outDoneBytes ) *outDoneBytes = total - rem;
	if ( outTotalBytes ) *outTotalBytes = total;
}

int demoConvertStep( int maxBytes ) {
	if ( !s_demoConvertState.active ) {
		return 0;
	}
	fileHandle_t	oldHandle = s_demoConvertState.oldHandle;
	fileHandle_t	&newHandle = s_demoConvertState.newHandle;
	int				&oldSize = s_demoConvertState.oldSize;
	int				&msgSequence = s_demoConvertState.msgSequence;
	int				&oldTime = s_demoConvertState.oldTime;
	int				&fullTime = s_demoConvertState.fullTime;
	int				&clientNum = s_demoConvertState.clientNum;
	int				&parseEntitiesNum = s_demoConvertState.parseEntitiesNum;
	demoConvert_t	*convert = s_demoConvertState.convert;
	char			*bigConfigString = s_demoConvertState.bigConfigString;
	int				&bigConfigNumber = s_demoConvertState.bigConfigNumber;
	int				&levelCount = s_demoConvertState.levelCount;
	const char		*newBaseName = s_demoConvertState.newBaseName;
	char			*newName = s_demoConvertState.newName;
	qboolean		smoothen = s_demoConvertState.smoothen;

	int				temp;
	msg_t			oldMsg;
	byte			oldData[ MAX_MSGLEN ];
	int				nextTime;
	demoFrame_t		*workFrame;
	const char		*s;
	clSnapshot_t	*oldSnap = 0;
	clSnapshot_t	*newSnap;
	short			rmgDataSize = 0;
	short			flatDataSize = 0;
	short			automapCount = 0;
	int				i = 0;
	int				bytesProcessed = 0;

	while ( oldSize > 0 ) {
		int startOldSize = oldSize;
		MSG_Init( &oldMsg, oldData, sizeof( oldData ) );
		/* Read the sequence number */
		if (FS_Read( &convert->messageNum, 4, oldHandle) != 4)
			goto conversionerror;
		convert->messageNum = LittleLong( convert->messageNum );
		oldSize -= 4;
		/* Read the message size */
		if (FS_Read( &oldMsg.cursize,4, oldHandle) != 4)
			goto conversionerror;
		oldSize -= 4;
		oldMsg.cursize = LittleLong( oldMsg.cursize );
		/* Negative size signals end of demo */
		if (oldMsg.cursize < 0) {
			oldSize = 0;
			break;
		}
		if ( oldMsg.cursize > oldMsg.maxsize ) 
			goto conversionerror;
		/* Read the actual message */
		if (FS_Read( oldMsg.data, oldMsg.cursize, oldHandle ) != oldMsg.cursize)
			goto conversionerror;
		oldSize -= oldMsg.cursize;
		// init the bitstream
		MSG_BeginReading( &oldMsg );
		// Skip the reliable sequence acknowledge number
		MSG_ReadLong( &oldMsg );
		//
		// parse the message
		//
		while ( 1 ) {
			byte cmd;
			if ( oldMsg.readcount > oldMsg.cursize ) {
				Com_Printf("Demo conversion, read past end of server message.\n");
				goto conversionerror;
			}
            cmd = MSG_ReadByte( &oldMsg );
			if ( cmd == svc_EOF) {
                break;
			}
			workFrame = &convert->frames[ convert->frameIndex % DEMOCONVERTFRAMES ];
			// other commands
			switch ( cmd ) {
			default:
				Com_Printf(S_COLOR_RED"ERROR: CL_ParseServerMessage: Illegible server message\n");
				goto conversionerror;
			case svc_nop:
				break;
			case svc_serverCommand:
				temp = MSG_ReadLong( &oldMsg );
				s = MSG_ReadString( &oldMsg );
				if (temp<=msgSequence)
					break;
//				Com_Printf( " server command %s\n", s );
				msgSequence = temp;
				Cmd_TokenizeString( s );
	
				if ( !Q_stricmp( Cmd_Argv(0), "bcs0" ) ) {
					bigConfigNumber = atoi( Cmd_Argv(1) );
					Q_strncpyz( bigConfigString, Cmd_Argv(2), BIG_INFO_STRING );
					break;
				}
				if ( !Q_stricmp( Cmd_Argv(0), "bcs1" ) ) {
					Q_strcat( bigConfigString, BIG_INFO_STRING, Cmd_Argv(2));
					break;
				}
				if ( !Q_stricmp( Cmd_Argv(0), "bcs2" ) ) {
					Q_strcat( bigConfigString, BIG_INFO_STRING, Cmd_Argv(2));
					demoFrameAddString( &workFrame->string, bigConfigNumber, bigConfigString );
					break;
				}
				if ( !Q_stricmp( Cmd_Argv(0), "cs" ) ) {
					int num = atoi( Cmd_Argv(1) );
					s = Cmd_ArgsFrom( 2 );
					demoFrameAddString( &workFrame->string, num, Cmd_ArgsFrom( 2 ) );	
					break;
				}
				if ( clientNum >= 0 && clientNum < MAX_CLIENTS ) {
					int len = strlen( s ) + 1;
					char *dst;
					if (workFrame->commandUsed + len + 1 > sizeof( workFrame->commandData)) {
						Com_Printf("Overflowed state command data.\n");
						goto conversionerror;
					}
					dst = workFrame->commandData + workFrame->commandUsed;
					*dst = clientNum;
					Com_Memcpy( dst+1, s, len );
					workFrame->commandUsed += len + 1;
				}
				break;
			case svc_gamestate:
				if (newHandle) {
					int flushStart = convert->frameIndex - (DEMOCONVERTFRAMES/2);
					int flushIdx;
					if (flushStart < 0)
						flushStart = 0;
					for (flushIdx = flushStart; flushIdx < convert->frameIndex; flushIdx++) {
						const demoFrame_t *newFrame = &convert->frames[ flushIdx % DEMOCONVERTFRAMES ];
						const demoFrame_t *oldFrame = 0;
						if ( newFrame->serverTime > fullTime || flushIdx <= 0 ) {
							fullTime = newFrame->serverTime + 2000;
						} else {
							oldFrame = &convert->frames[ ( flushIdx - 1 ) % DEMOCONVERTFRAMES ];
						}
						demoConvertEmitFrame( newHandle, newFrame, oldFrame, (qboolean)(levelCount == 1) );
					}
					if ( levelCount == 1 ) {
						s_cachedMmeIndex.valid = qtrue;
					}
					FS_FCloseFile( newHandle );
					newHandle = 0;
				}
				if (levelCount) {
					demo.firstPack = qtrue;
					Com_sprintf( newName, MAX_OSPATH, "%s.%d.mme", newBaseName, levelCount );
				} else {
					Com_sprintf( newName, MAX_OSPATH, "%s.mme", newBaseName );
				}
				fullTime = -1;
				clientNum = -1;
				oldTime = -1;
				Com_Memset( convert, 0, sizeof( *convert ));
				convert->frames[0].string.used = 1;
				levelCount++;
				newHandle = FS_FOpenFileWrite( newName );
				if (!newHandle) {
					Com_Printf("Failed to open %s for target conversion target.\n", newName);
					goto conversionerror;
				} else {
					int hdrLen = (int)strlen( demoHeader );
					FS_Write ( demoHeader, hdrLen, newHandle );
					if ( levelCount == 1 ) {
						Com_Memset( &s_cachedMmeIndex, 0, sizeof( s_cachedMmeIndex ) );
						Q_strncpyz( s_cachedMmeIndex.fileName, newName, sizeof( s_cachedMmeIndex.fileName ) );
						s_cachedMmeIndex.fileSize = hdrLen;
					}
				}
				Com_sprintf( newName, MAX_OSPATH, "%s.txt", newBaseName );
				workFrame = &convert->frames[ convert->frameIndex % DEMOCONVERTFRAMES ];
				msgSequence = MSG_ReadLong( &oldMsg );
				while( 1 ) {
					cmd = MSG_ReadByte( &oldMsg );
					if (cmd == svc_EOF)
						break;
					if ( cmd == svc_configstring) {
						int		num;
						const char *s;
						num = MSG_ReadShort( &oldMsg );
						s = MSG_ReadBigString( &oldMsg );
						demoFrameAddString( &workFrame->string, num, s );
					} else if ( cmd == svc_baseline ) {
						int num = MSG_ReadBits( &oldMsg, GENTITYNUM_BITS );
						if ( num < 0 || num >= MAX_GENTITIES ) {
							Com_Printf( "Baseline number out of range: %i.\n", num );
							goto conversionerror;
						}
						MSG_ReadDeltaEntity( &oldMsg, &demoNullEntityState, &convert->entityBaselines[num], num );
						memcpy(&workFrame->entityBaselines[num], &convert->entityBaselines[num], sizeof(entityState_t));
					} else {
						Com_Printf( "Unknown block while converting demo gamestate.\n" );
						goto conversionerror;
					}
				}
				clientNum = MSG_ReadLong( &oldMsg );
				/* Skip the checksum feed */
				MSG_ReadLong( &oldMsg );

				// RMG stuff
				rmgDataSize = MSG_ReadShort(&oldMsg);
				if( rmgDataSize != 0) {
					unsigned char dataBuffer[MAX_HEIGHTMAP_SIZE];
					// height map
					MSG_ReadBits(&oldMsg, 1);
					MSG_ReadData(&oldMsg, dataBuffer, rmgDataSize);

					// Flatten map
					flatDataSize = MSG_ReadShort(&oldMsg);
					MSG_ReadBits(&oldMsg, 1);
					MSG_ReadData(&oldMsg, dataBuffer, flatDataSize);

					// Seed
					MSG_ReadLong(&oldMsg);

					// Automap symbols
					automapCount = MSG_ReadShort(&oldMsg);
					for(i = 0; i < automapCount; i++) {
						MSG_ReadByte(&oldMsg);
						MSG_ReadByte(&oldMsg);
						MSG_ReadLong(&oldMsg);
						MSG_ReadLong(&oldMsg);
					}
				}
				break;
			case svc_snapshot:
				nextTime = MSG_ReadLong( &oldMsg );
				/* Delta number, not needed */
				newSnap = &convert->snapshots[convert->messageNum & PACKET_MASK];
				Com_Memset (newSnap, 0, sizeof(*newSnap));
				newSnap->deltaNum = MSG_ReadByte( &oldMsg );
				newSnap->messageNum = convert->messageNum;
				if (!newSnap->deltaNum) {
					newSnap->deltaNum = -1;
					newSnap->valid = qtrue;		// uncompressed frame
					oldSnap  = NULL;
				} else {
					newSnap->deltaNum = newSnap->messageNum - newSnap->deltaNum;
					oldSnap = &convert->snapshots[newSnap->deltaNum & PACKET_MASK];
					if (!oldSnap->valid) {
						Com_Printf( "Delta snapshot without base.\n" );
//						goto conversionerror;
					} else if (oldSnap->messageNum != newSnap->deltaNum) {
						// The frame that the server did the delta from
						// is too old, so we can't reconstruct it properly.
						Com_Printf ("Delta frame too old.\n");
					} else if ( parseEntitiesNum - oldSnap->parseEntitiesNum > MAX_PARSE_ENTITIES-128 ) {
						Com_Printf ("Delta parseEntitiesNum too old.\n");
					} else {
						newSnap->valid = qtrue;	// valid delta parse
					}
				}

				/* Snapflags, not needed */
				newSnap->snapFlags = MSG_ReadByte( &oldMsg );
				// read areamask
				workFrame->areaUsed = MSG_ReadByte( &oldMsg );
				MSG_ReadData( &oldMsg, workFrame->areamask, workFrame->areaUsed );
				if (clientNum <0 || clientNum >= MAX_CLIENTS) {
					Com_Printf("Got snapshot with invalid client.\n");
					goto conversionerror;
				}
				MSG_ReadDeltaPlayerstate( &oldMsg, oldSnap ? &oldSnap->ps : &demoNullPlayerState, &newSnap->ps );
				if( newSnap->ps.m_iVehicleNum)
					MSG_ReadDeltaPlayerstate( &oldMsg, oldSnap ? &oldSnap->vps : &demoNullPlayerState, &newSnap->vps, qtrue );
				/* Read the individual entities */
				newSnap->parseEntitiesNum = parseEntitiesNum;
				newSnap->numEntities = 0;
				Com_Memset( workFrame->entityData, 0, sizeof( workFrame->entityData ));

				/* The beast that is entity parsing */
				{
				int			newnum;
				entityState_t	*oldstate, *newstate;
				int			oldindex = 0;
				int			oldnum;
				newnum = MSG_ReadBits( &oldMsg, GENTITYNUM_BITS );
				while ( 1 ) {
					// read the entity index number
					if (oldSnap && oldindex < oldSnap->numEntities) {
						oldstate = &convert->parseEntities[(oldSnap->parseEntitiesNum + oldindex) & (MAX_PARSE_ENTITIES-1)];
						oldnum = oldstate->number;
					} else {
						oldstate = 0;
						oldnum = 99999;
					}
					newstate = &convert->parseEntities[parseEntitiesNum];
					if ( !oldstate && (newnum == (MAX_GENTITIES-1))) {
						break;
					} else if ( oldnum < newnum ) {
						*newstate = *oldstate;
						oldindex++;
					} else if (oldnum == newnum) {
						oldindex++;
						MSG_ReadDeltaEntity( &oldMsg, oldstate, newstate, newnum );
						if ( newstate->number != MAX_GENTITIES-1)
							workFrame->entityData[ newstate->number ] = 1;
						newnum = MSG_ReadBits( &oldMsg, GENTITYNUM_BITS );
					} else if (oldnum > newnum) {
						MSG_ReadDeltaEntity( &oldMsg, &convert->entityBaselines[newnum], newstate , newnum );
						if ( newstate->number != MAX_GENTITIES-1)
							workFrame->entityData[ newstate->number ] = 1;
						newnum = MSG_ReadBits( &oldMsg, GENTITYNUM_BITS );
					}
					if (newstate->number == MAX_GENTITIES-1)
						continue;
					parseEntitiesNum++;
					parseEntitiesNum &= (MAX_PARSE_ENTITIES-1);
					newSnap->numEntities++;
				}}
				/* Stop processing this further since it's an invalid snap due to lack of delta data */
				if (!newSnap->valid)
					break;

				/* Skipped snapshots will be set invalid in the circular buffer */
				if ( newSnap->messageNum - convert->lastMessageNum >= PACKET_BACKUP ) {
					convert->lastMessageNum = newSnap->messageNum - ( PACKET_BACKUP - 1 );
				}
				for ( ; convert->lastMessageNum < newSnap->messageNum ; convert->lastMessageNum++ ) {
					convert->snapshots[convert->lastMessageNum & PACKET_MASK].valid = qfalse;
				}
				convert->lastMessageNum = newSnap->messageNum + 1;

				/* compress the frame into the new format */
				if (nextTime > oldTime) {
					demoFrame_t *cleanFrame;
					int writeIndex;
					for (temp = 0;temp<newSnap->numEntities;temp++) {
						int p = (newSnap->parseEntitiesNum+temp) & (MAX_PARSE_ENTITIES-1);
						entityState_t *newState = &convert->parseEntities[p];
						workFrame->entities[newState->number] = *newState;
					}
					workFrame->clientData[clientNum] = 1;
					workFrame->clients[clientNum] = newSnap->ps;
					workFrame->vehs[clientNum] = newSnap->vps;
					workFrame->serverTime = nextTime;

					/* Which frame from the cache to save */
					writeIndex = convert->frameIndex - (DEMOCONVERTFRAMES/2);
					if (writeIndex >= 0) {
						const demoFrame_t *newFrame = &convert->frames[ writeIndex % DEMOCONVERTFRAMES ];
						const demoFrame_t *oldFrame = 0;
						if ( smoothen )
							demoFrameInterpolate( convert->frames, DEMOCONVERTFRAMES, writeIndex );
						if ( nextTime > fullTime || writeIndex <= 0 ) {
							/* Plan the next time for a full write */
							fullTime = nextTime + 2000;
						} else {
							oldFrame = &convert->frames[ ( writeIndex - 1 ) % DEMOCONVERTFRAMES ];
						}
						demoConvertEmitFrame( newHandle, newFrame, oldFrame, (qboolean)(levelCount == 1) );
					}

					/* Clean up the upcoming frame for all new changes */
					convert->frameIndex++;
					cleanFrame = &convert->frames[ convert->frameIndex % DEMOCONVERTFRAMES];
					cleanFrame->serverTime = 0;
					for (temp = 0;temp<MAX_GENTITIES;temp++)
						cleanFrame->entities[temp].number = MAX_GENTITIES-1;
					Com_Memset( cleanFrame->clientData, 0, sizeof ( cleanFrame->clientData ));
					Com_Memcpy( cleanFrame->string.data, workFrame->string.data, workFrame->string.used );
					Com_Memcpy( cleanFrame->string.offsets, workFrame->string.offsets, sizeof( workFrame->string.offsets ));
					cleanFrame->string.used = workFrame->string.used;
					cleanFrame->commandUsed = 0;
					/* keep track of this last frame's time */
					oldTime = nextTime;
				}
				break;
			case svc_download:
				// read block number
				temp = MSG_ReadShort ( &oldMsg );
				if (!temp)	//0 block, read file size
					MSG_ReadLong( &oldMsg );
				// read block size
				temp = MSG_ReadShort ( &oldMsg );
				// read the data block
				for ( ;temp>0;temp--)
					MSG_ReadByte( &oldMsg );
				break;
			case svc_setgame:
				i = 0;
				while (i < MAX_QPATH) {
					if (!MSG_ReadByte(&oldMsg))
						break;
					i++;
				}
				break;
			case svc_mapchange:
				// nothing to parse.
				break;
			}
		}
		bytesProcessed += ( startOldSize - oldSize );
		if ( maxBytes > 0 && bytesProcessed >= maxBytes && oldSize > 0 ) {
			return 1;
		}
	}
	if (newHandle && convert->frameIndex > 0) {
		int flushStart = convert->frameIndex - (DEMOCONVERTFRAMES/2);
		int flushIdx;
		if (flushStart < 0)
			flushStart = 0;
		for (flushIdx = flushStart; flushIdx < convert->frameIndex; flushIdx++) {
			const demoFrame_t *newFrame = &convert->frames[ flushIdx % DEMOCONVERTFRAMES ];
			const demoFrame_t *oldFrame = 0;
			if ( newFrame->serverTime > fullTime || flushIdx <= 0 ) {
				fullTime = newFrame->serverTime + 2000;
			} else {
				oldFrame = &convert->frames[ ( flushIdx - 1 ) % DEMOCONVERTFRAMES ];
			}
			demoConvertEmitFrame( newHandle, newFrame, oldFrame, (qboolean)(levelCount == 1) );
		}
		if ( levelCount == 1 ) {
			s_cachedMmeIndex.valid = qtrue;
		}
	}
	demoConvertCleanup();
	return 0;
conversionerror:
	s_cachedMmeIndex.valid = qfalse;
	demoConvertCleanup();
	return -1;
}

void demoConvert( const char *oldName, const char *newBaseName, qboolean smoothen ) {
	if ( demoConvertBegin( oldName, newBaseName, smoothen ) ) {
		while ( demoConvertStep( 0x7fffffff ) > 0 ) {}
	}
}

void demoCommandSmoothingEnable(qboolean enable) {
	demo.commandSmoothing = enable;
}

qboolean demoCommandSmoothingState(void) {
	return demo.commandSmoothing;
}

static void demoPlayAddCommand( demoPlay_t *play, const char *cmd ) {
	int len = strlen ( cmd ) + 1;
	int index = (++play->commandCount) % DEMO_PLAY_CMDS;
	int freeWrite;
	/* First clear previous command */
	int nextStart = play->commandStart[ index ];
	if (play->commandFree > nextStart) {
		int freeNext = sizeof( play->commandData ) - play->commandFree;
		if ( len <= freeNext ) {
			freeWrite = play->commandFree;
			play->commandFree += len;
		} else {
			if ( len > nextStart )
					Com_Error( ERR_DROP, "Ran out of server command space");
			freeWrite = 0;
			play->commandFree = len;
		}
	} else {
		int left = nextStart - play->commandFree;
		if ( len > left )
			Com_Error( ERR_DROP, "Ran out of server command space");
		freeWrite = play->commandFree;
		play->commandFree = (play->commandFree + len) % sizeof( play->commandData );
	}
	play->commandStart[ index ] = freeWrite;
	Com_Memcpy( play->commandData + freeWrite, cmd, len );
}

static void demoPlaySynch( demoPlay_t *play, demoFrame_t *frame) {
	int i;
	int startCount = play->commandCount;
	int totalLen = 0;
	for (i = 0;i<MAX_CONFIGSTRINGS;i++) {
		if ( !cl.gameState.stringOffsets[i] && !frame->string.offsets[i] )
			continue;
		char *oldString = cl.gameState.stringData + cl.gameState.stringOffsets[i];
		char *newString = frame->string.data + frame->string.offsets[i];
		if (!strcmp( oldString, newString ))
			continue;
		totalLen += strlen( newString );
		demoPlayAddCommand( play, va("cs %d \"%s\"", i, newString) );
	}
	/* Copy the new server commands */
	for (i=0;i<frame->commandUsed;) {
		char *line = frame->commandData + i;
		int len, cmdClient;

		cmdClient = *line++;
		len = strlen( line ) + 1;
		i += len + 1;
		if ( cmdClient != play->clientNum ) 
			continue;
		demoPlayAddCommand( play, line );
		totalLen += strlen( line );
	}
	if (play->commandCount - startCount > DEMO_PLAY_CMDS) {
		Com_Error( ERR_DROP, "frame added more than %d commands", DEMO_PLAY_CMDS);
	}
//	Com_Printf("Added %d commands, length %d\n", play->commandCount - startCount, totalLen );
}

extern void Com_RecoverFromThrownError( int code );

static void demoPlayForwardFrame( demoPlay_t *play ) {
	int			blockSize;
	msg_t		msg;

	if ( !play ) {
		return;
	}
	if (play->filePos + 4 > play->fileSize) {
		if (demo.commandSmoothing && play->frameNumber == -1) {
			play->frame = play->nextFrame;
			play->frameNumber = 0;
		}
		if (mme_demoAutoNext->integer && demo.nextNum && !demo.precaching) {
			CL_Disconnect_f();
		}
		if (mme_demoAutoQuit->integer && !demo.precaching) {
			if (mme_demoAutoQuit->integer == 2)
				Cbuf_ExecuteText( EXEC_APPEND, "quit" );
			CL_Disconnect_f();
		}
		play->lastFrame = qtrue;
		return;
	}
	play->lastFrame = qfalse;
#ifdef __EMSCRIPTEN__
	if ( s_mmeStreamActive ) {
		if ( wasm_js_mme_read( play->filePos, &blockSize, 4 ) != 4 ) {
			play->lastFrame = qtrue;
			return;
		}
		play->filePos += 4;
		blockSize = LittleLong( blockSize );
		if ( blockSize <= 0 || blockSize > (int)sizeof( demo.buffer ) || wasm_js_mme_read( play->filePos, demo.buffer, blockSize ) != blockSize ) {
			play->lastFrame = qtrue;
			return;
		}
		play->filePos += blockSize;
	} else
#endif
	{
		play->filePos += 4;
		if ( FS_Read( &blockSize, 4, play->fileHandle ) != 4 ) {
			play->lastFrame = qtrue;
			return;
		}
		blockSize = LittleLong( blockSize );
		if ( blockSize <= 0 || blockSize > (int)sizeof( demo.buffer ) || FS_Read( demo.buffer, blockSize, play->fileHandle ) != blockSize ) {
			play->lastFrame = qtrue;
			return;
		}
		play->filePos += blockSize;
	}
	MSG_Init( &msg, demo.buffer, sizeof(demo.buffer) );
	MSG_BeginReading( &msg );
	msg.cursize = blockSize;
	if (demo.commandSmoothing) {
		play->frame = &play->storageFrame[(((play->frameNumber + 1) % FRAME_BUF_SIZE) + FRAME_BUF_SIZE) % FRAME_BUF_SIZE];
		play->nextFrame = &play->storageFrame[(((play->frameNumber + 2) % FRAME_BUF_SIZE) + FRAME_BUF_SIZE) % FRAME_BUF_SIZE];
	} else {
		if ( !play->frame || !play->nextFrame ) {
			play->lastFrame = qtrue;
			return;
		}
		demoFrame_t *copyFrame = play->frame;
		play->frame = play->nextFrame;
		play->nextFrame = copyFrame;
	}
#ifdef __EMSCRIPTEN__
	g_msgRawBitstream = qtrue;
#endif
	try {
		demoFrameUnpack( &msg, play->frame, play->nextFrame, &demo.firstPack );
	} catch ( int code ) {
#ifdef __EMSCRIPTEN__
		g_msgRawBitstream = qfalse;
#endif
		play->lastFrame = qtrue;
		Com_RecoverFromThrownError( code );
		return;
	}
#ifdef __EMSCRIPTEN__
	g_msgRawBitstream = qfalse;
#endif
	play->frameNumber++;
}

static void demoPlaySetIndex( demoPlay_t *play, int index ) {
	int wantPos;
	if ( !play || play->fileIndexCount <= 0 ) {
		if ( play ) {
			play->lastFrame = qtrue;
		}
		return;
	}
	if (index <0 || index >= play->fileIndexCount) {
		Com_Printf("demoFile index Out of range search\n");
		index = 0;
	}
	wantPos = play->fileIndex[index].pos;
#if 0
	if ( !play->fileHandle || play->filePos > wantPos) {
		trap_FS_FCloseFile( play->fileHandle );
		trap_FS_FOpenFile( play->fileName, &play->fileHandle, FS_READ );
		play->filePos = 0;
	}
	if (!play->fileHandle)
		Com_Error(0, "Failed to open demo file \n");
	while (play->filePos < wantPos) {
		int toRead = wantPos - play->filePos;
		if (toRead > sizeof(demoBuffer))
			toRead = sizeof(demoBuffer);
		play->filePos += toRead;
		trap_FS_Read( demoBuffer, toRead, play->fileHandle );
	}
#else
#ifdef __EMSCRIPTEN__
	if ( !s_mmeStreamActive ) {
		FS_Seek( play->fileHandle, wantPos, FS_SEEK_SET );
	}
	play->filePos = wantPos;
#else
	FS_Seek( play->fileHandle, wantPos, FS_SEEK_SET );
	play->filePos = wantPos;
#endif
#endif

	if (demo.commandSmoothing)
		play->frameNumber = play->fileIndex[index].frame - 2;

	demoPlayForwardFrame( play );
	demoPlayForwardFrame( play );

	if (!demo.commandSmoothing)
		play->frameNumber = play->fileIndex[index].frame;
}
static int demoPlaySeek(demoPlay_t *play, int seekTime) {
	int i;
	int curFrameTime;
	if (!play || play->fileIndexCount <= 0 || !play->frame || !play->nextFrame)
		return 0;
	play->seekTime = seekTime;
	seekTime += play->startTime;
	if (seekTime < 0)
		seekTime = 0;
	curFrameTime = (demo.commandSmoothing && play->frameNumber > 0)
		? play->storageFrame[(play->frameNumber - 1 + FRAME_BUF_SIZE) % FRAME_BUF_SIZE].serverTime
		: play->frame->serverTime;
	if (seekTime < curFrameTime || (seekTime > curFrameTime + 1000)) {
		for (i=0;i<(play->fileIndexCount-1);i++) {
			if (play->fileIndex[i].time <= seekTime && 
				play->fileIndex[i+1].time > seekTime)
				goto foundit;
		}
		i = play->fileIndexCount-1;
foundit:
		demoPlaySetIndex(play, i);
	}
	while (!play->lastFrame && (demo.commandSmoothing ? (seekTime >= play->frame->serverTime) : (seekTime > play->nextFrame->serverTime))) {
		demoPlayForwardFrame(play);
	}
	return seekTime;
}
int demoLength(void) {
	demoPlay_t *play = demo.play.handle;
	if (!play)
		return 0;
	return play->endTime - play->startTime;
}
int demoTime(void) {
	demoPlay_t *play = demo.play.handle;
	if (!play)
		return 0;
	if (play->seekTime < 0)
		play->seekTime = 0;
	return play->seekTime;
}
qboolean demoIsMMEPlaying(void) {
	return (qboolean)(clc.newDemoPlayer && demo.play.handle != 0);
}
int demoStartTime(void) {
	demoPlay_t *play = demo.play.handle;
	return play ? play->startTime : 0;
}
int demoEndTime(void) {
	demoPlay_t *play = demo.play.handle;
	return play ? play->endTime : 0;
}
int demoTotalFrames(void) {
	demoPlay_t *play = demo.play.handle;
	return play ? play->totalFrames : 0;
}
float demoProgress(void) {
	int pos = demoTime();
	int length = demoLength();
	length = length ? length : 1;
	return (float)pos/length;
}
static int demoFindNext(const char *fileName) {
	int i;
	int len = strlen(fileName);
	char name[MAX_QPATH], seekName[MAX_QPATH];
	qboolean tryAgain = qtrue;
	if (len > MAX_QPATH) {
		Com_Printf(S_COLOR_YELLOW"WARNING: Demo name length too big: %d > %d\n", len, MAX_QPATH);
		len = MAX_QPATH;
	}
	Com_sprintf(seekName, MAX_QPATH, fileName);
	if (isdigit(fileName[len-1]) && ((fileName[len-2] == '.'))) {
		seekName[len-2] = 0;
		demo.currentNum = fileName[len-1] - '0';
	} else if (isdigit(fileName[len-1]) && (isdigit(fileName[len-2]) && (fileName[len-3] == '.'))) {
		seekName[len-3] = 0;
		demo.currentNum = (fileName[len-2] - '0')*10 + (fileName[len-1] - '0');
	} else {
		demo.currentNum = demo.nextNum;
		tryAgain = qfalse;
	}
	do {
		for (i = demo.currentNum + 1; i < 100; i++) {
			Com_sprintf(name, MAX_QPATH, "mmedemos/%s.%d.mme", seekName, i);
			if (FS_FileExists(name)) {
				Com_Printf("Next demo file: %s\n", name);
				return i;
			}
		}
		if (tryAgain) {
			Com_sprintf(seekName, MAX_QPATH, fileName);
			tryAgain = qfalse;
		} else {
			break;
		}
	} while (1);
	return 0;
}

static demoPlay_t *demoPlayOpen( const char* fileName ) {
	demoPlay_t	*play;
	fileHandle_t fileHandle;
	int	fileSize, filePos;
	int i;

	msg_t msg;
#ifdef __EMSCRIPTEN__
	if ( s_mmeStreamActive && s_mmeStreamFileSize > 0 ) {
		fileHandle = 0;
		fileSize = s_mmeStreamFileSize;
		filePos = strlen( demoHeader );
		i = wasm_js_mme_read( 0, &demo.buffer, filePos );
		if ( i != filePos || Q_strncmp( (char *)demo.buffer, demoHeader, filePos ) ) {
			Com_Printf( "streamed demo file %s is wrong version\n", fileName );
			return 0;
		}
		demo.nextNum = 0;
	} else
#endif
	{
		fileSize = FS_FOpenFileRead( fileName, &fileHandle, qtrue );
		if (fileHandle<=0) {
			Com_Printf("Failed to open demo file %s \n", fileName );
			return 0;
		}
		filePos = strlen( demoHeader );
		i = FS_Read( &demo.buffer, filePos, fileHandle );
		if ( i != filePos || Q_strncmp( (char *)demo.buffer, demoHeader, filePos )) {
			Com_Printf("demo file %s is wrong version\n", fileName );
			FS_FCloseFile( fileHandle );
			return 0;
		}
		demo.nextNum = demoFindNext(mme_demoFileName->string);
	}
	if ( filePos == fileSize) {
		Com_Printf("demo file %s is empty\n", fileName );
		if ( fileHandle > 0 ) FS_FCloseFile( fileHandle );
		return 0;
	}
	Com_SetLoadingMsg("Opening the demo...");
	play = (demoPlay_t *)Z_Malloc( sizeof( demoPlay_t ), TAG_GENERAL);//what tag do we need?
	memset( play, 0, sizeof(demoPlay_t) ); // In Q3MME the Z_Malloc doees a memset 0, it doesn't here though. So we gotta do it.
	Q_strncpyz( play->fileName, fileName, sizeof( play->fileName ));
	play->fileSize = fileSize;
	play->frame = &play->storageFrame[0];
	play->nextFrame = &play->storageFrame[1];
	for (i=0;i<DEMO_PLAY_CMDS;i++)
		play->commandStart[i] = i;
	play->commandFree = DEMO_PLAY_CMDS;

	if ( s_cachedMmeIndex.valid
		&& ( s_mmeStreamActive || !Q_stricmp( s_cachedMmeIndex.fileName, fileName ) )
		&& s_cachedMmeIndex.fileSize == fileSize
		&& s_cachedMmeIndex.totalFrames > 0 ) {
		play->startTime = s_cachedMmeIndex.startTime;
		play->endTime = s_cachedMmeIndex.endTime;
		play->totalFrames = s_cachedMmeIndex.totalFrames;
		play->fileIndexCount = s_cachedMmeIndex.fileIndexCount;
		if ( play->fileIndexCount > 0 ) {
			Com_Memcpy( play->fileIndex, s_cachedMmeIndex.fileIndex, play->fileIndexCount * sizeof( play->fileIndex[0] ) );
		}
	} else {
		for ( ; filePos<fileSize; ) {
			int blockSize, isFull, serverTime;
			FS_Read( &blockSize, 4, fileHandle );
			blockSize = LittleLong( blockSize );
			if (blockSize > sizeof(demo.buffer)) {
				Com_Printf( "Block too large to be read in.\n");
				goto errorreturn;
			}
			if ( blockSize + filePos > fileSize) {
				Com_Printf( "Block would read past the end of the file.\n");
				goto errorreturn;
			}
			int hdrSize = ( blockSize < 16 ) ? blockSize : 16;
			FS_Read( demo.buffer, hdrSize, fileHandle );
			if ( blockSize > hdrSize ) {
				FS_Seek( fileHandle, blockSize - hdrSize, FS_SEEK_CUR );
			}
			MSG_Init( &msg, demo.buffer, sizeof(demo.buffer) );
			MSG_BeginReading( &msg );
			msg.cursize = hdrSize;	
#ifdef __EMSCRIPTEN__
			g_msgRawBitstream = qtrue;
#endif
			isFull = MSG_ReadBits( &msg, 1 );
			serverTime = MSG_ReadLong( &msg );
#ifdef __EMSCRIPTEN__
			g_msgRawBitstream = qfalse;
#endif
			if (!play->startTime)
				play->startTime = serverTime;
			if (isFull) {
				if (play->fileIndexCount < DEMO_MAX_INDEX) {
					play->fileIndex[play->fileIndexCount].pos = filePos;
					play->fileIndex[play->fileIndexCount].frame = play->totalFrames;
					play->fileIndex[play->fileIndexCount].time = serverTime;
					play->fileIndexCount++;
				}
			}
			play->endTime = serverTime;
			filePos += 4 + blockSize;
			play->totalFrames++;
		}
	}
	play->fileHandle = fileHandle;
	demo.firstPack = qtrue;
	demoPlaySetIndex( play, 0 );
	play->clientNum = -1;
	for( i=0;i<MAX_CLIENTS;i++)
		if (play->frame->clientData[i]) {
			play->clientNum = i;
			break;
		}
	return play;
errorreturn:
	Z_Free( play );
	if ( fileHandle > 0 ) FS_FCloseFile( fileHandle );
	return 0;
}

static void demoPlayStop(demoPlay_t *play) {
	if ( play->fileHandle > 0 ) {
		FS_FCloseFile( play->fileHandle );
	}
	if ((mme_demoRemove->integer || demo.del) && FS_FileExists(play->fileName)) {
		FS_FileErase(play->fileName);
	}
	if (demo.del) {
		char demoPath[MAX_QPATH];
		char *ext = Cvar_FindVar("mme_demoExt")->string;
		if (!*ext)
			ext = ".dm_26";
		Com_sprintf(demoPath, sizeof(demoPath), "demos/%s%s", mme_demoFileName->string, ext);
		if (FS_FileExists(demoPath)) {
			FS_FileErase(demoPath);
		}
	}
	Z_Free(play);
	demo.del = qfalse;
}

qboolean demoGetDefaultState(int index, entityState_t *state) {
	demoPlay_t *play = demo.play.handle;
	if (index < 0 || index >= MAX_GENTITIES)
		return qfalse;
	if (play && (play->frame->entityBaselines[index].eFlags & EF_PERMANENT)) {
		*state = play->frame->entityBaselines[index];
		return qtrue;
	}
	if (s_mmeEntityBaselines[index].eFlags & EF_PERMANENT) {
		*state = s_mmeEntityBaselines[index];
		return qtrue;
	}
	return qfalse;
}

extern void CL_ConfigstringModified( void );
qboolean demoGetServerCommand( int cmdNumber ) {
	demoPlay_t *play = demo.play.handle;
	int index = ((cmdNumber % DEMO_PLAY_CMDS) + DEMO_PLAY_CMDS) % DEMO_PLAY_CMDS;
	const char *cmd;

	if ( !play )
		return qfalse;
	if (cmdNumber < play->commandCount - DEMO_PLAY_CMDS || cmdNumber > play->commandCount )
		return qfalse;
	
	Cmd_TokenizeString( play->commandData + play->commandStart[index] );

	cmd = Cmd_Argv( 0 );
	if ( !strcmp( cmd, "cs" ) ) {
		CL_ConfigstringModified();
	}
	if (!strcmp(cmd, "lchat") && Cmd_Argc() > 3) {
		cvar_t *cg_teamChatsOnly = Cvar_FindVar("cg_teamChatsOnly");
		if (cg_teamChatsOnly && !cg_teamChatsOnly->integer)
			Con_SetFilter(CON_FILTER_CHAT);
	} else if (!strcmp(cmd, "ltchat") && Cmd_Argc() > 3) {
		Con_SetFilter(CON_FILTER_TEAMCHAT);
	} else if (!strcmp(cmd, "chat")) {
		cvar_t *cg_teamChatsOnly = Cvar_FindVar("cg_teamChatsOnly");
		if (cg_teamChatsOnly && !cg_teamChatsOnly->integer)
			Con_SetFilter(CON_FILTER_CHAT);
	} else if (!strcmp(cmd, "tchat")) {
		Con_SetFilter(CON_FILTER_TEAMCHAT);
	} else if (!strcmp(cmd, "print")) {
		Con_SetFilter(CON_FILTER_SERVER);
	}
	return qtrue;
}

int demoSeek( int seekTime ) {
	if ( !demo.play.handle ) {
		return 0;
	}
	return demoPlaySeek( demo.play.handle, seekTime );
}

void demoRenderFrame( stereoFrame_t stereo ) {
	if ( !cgvm ) {
		return;
	}
	VM_Call( cgvm, CG_DRAW_ACTIVE_FRAME, cls.realtime, stereo, 2 );	
}

void demoGetSnapshotNumber( int *snapNumber, int *serverTime ) {
	demoPlay_t *play = demo.play.handle;
	if ( !play || !play->frame || !play->nextFrame ) {
		if ( snapNumber ) *snapNumber = 0;
		if ( serverTime ) *serverTime = 0;
		return;
	}

	*snapNumber = play->frameNumber + (play->lastFrame ? 0 : 1);
	*serverTime = play->lastFrame ?  play->frame->serverTime : play->nextFrame->serverTime;
}

qboolean demoGetSnapshot( int snapNumber, snapshot_t *snap ) {
	demoPlay_t *play = demo.play.handle;
	demoFrame_t *frame;
	int i;

	if ( !play || !snap )
		return qfalse;
	if (demo.commandSmoothing && snapNumber < play->frameNumber - FRAME_BUF_SIZE + 2)
		return qfalse;
	if (!demo.commandSmoothing && snapNumber < play->frameNumber)
		return qfalse;
	if (snapNumber > play->frameNumber + 1)
		return qfalse;
	if (snapNumber == play->frameNumber + 1 && play->lastFrame)
		return qfalse;

	if (demo.commandSmoothing)
		frame = &play->storageFrame[((snapNumber % FRAME_BUF_SIZE) + FRAME_BUF_SIZE) % FRAME_BUF_SIZE];
	else
		frame = snapNumber == play->frameNumber ? play->frame : play->nextFrame;
	if ( !frame )
		return qfalse;

	demoPlaySynch( play, frame );
	snap->serverCommandSequence = play->commandCount;
	snap->serverTime = frame->serverTime;
	if (play->clientNum >=0 && play->clientNum < MAX_CLIENTS) {
		snap->ps = frame->clients[ play->clientNum ];
		snap->vps = frame->vehs[ play->clientNum ];
	} else {
		Com_Memset( &snap->ps, 0, sizeof(snap->ps) );
		Com_Memset( &snap->vps, 0, sizeof(snap->vps) );
	}

	snap->numEntities = 0;
	for (i=0;i<MAX_GENTITIES-1 && snap->numEntities < MAX_ENTITIES_IN_SNAPSHOT;i++) {
		if (frame->entities[i].number != i)
			continue;
		/* Skip your own entity if there ever comes server side recording */
		if (frame->entities[i].number == snap->ps.clientNum)
			continue;
		memcpy(&snap->entities[snap->numEntities++], &frame->entities[i], sizeof(entityState_t));
	}
	snap->snapFlags = 0;
	snap->ping = 0;
	snap->numServerCommands = 0;
	if ( frame->areaUsed > 0 && frame->areaUsed <= (int)sizeof( snap->areamask ) ) {
		Com_Memcpy( snap->areamask, frame->areamask, frame->areaUsed );
	}
	return qtrue;
}

#ifdef __EMSCRIPTEN__
extern "C" int CG_MME_GetTimeMs( void );
#endif

void CL_DemoSetCGameTime( void ) {
	/* We never timeout */
	clc.lastPacketTime = cls.realtime;
#ifdef __EMSCRIPTEN__
	if ( demoIsMMEPlaying() ) {
		cl.serverTime = demoStartTime() + CG_MME_GetTimeMs();
	}
#endif
}

void CL_DemoShutDown( void ) {
	if ( demo.play.handle ) {
		if ( demo.play.handle->fileHandle > 0 ) {
			FS_FCloseFile( demo.play.handle->fileHandle );
		}
		Z_Free( demo.play.handle );
		demo.play.handle = 0;
	}
}

void demoStop( void ) {
	if (demo.play.handle) {
		demoPlayStop( demo.play.handle );
	}
	Com_Memset( &demo.play, 0, sizeof( demo.play ));
}

static void demoPrecacheModel(char *str) {
	char skinName[MAX_QPATH], modelName[MAX_QPATH];
	char *p;
	qhandle_t skinID = 0;
	int i = 0;
	
	strcpy(modelName, str);
	if (strstr(modelName, ".glm")) {
		//Check to see if it has a custom skin attached.
		//see if it has a skin name
		p = Q_strrchr(modelName, '*');
		if (p) { //found a *, we should have a model name before it and a skin name after it.
			*p = 0; //terminate the modelName string at this point, then go ahead and parse to the next 0 for the skin.
			p++;
			while (p && *p) {
				skinName[i] = *p;
				i++;
				p++;
			}
			skinName[i] = 0;

			if (skinName[0]) { //got it, register the skin under the model path.
				char baseFolder[MAX_QPATH];

				strcpy(baseFolder, modelName);
				p = Q_strrchr(baseFolder, '/'); //go back to the first /, should be the path point

				if (p) { //got it.. terminate at the slash and register.
					char *useSkinName;
					*p = 0;
					if (strchr(skinName, '|')) {//three part skin
						useSkinName = va("%s/|%s", baseFolder, skinName);
					} else {
						useSkinName = va("%s/model_%s.skin", baseFolder, skinName);
					}
					skinID = re.RegisterSkin(useSkinName);
				}
			}
		}
	}
	re.RegisterModel( str );
}

static void demoPrecacheClient(char *str) {
	const char *v;
	int     team;
	char	modelName[MAX_QPATH];
	char	skinName[MAX_QPATH];
	char		*slash;
	qhandle_t torsoSkin;
	void	  *ghoul2;
	memset(&ghoul2, 0, sizeof(ghoul2));

	v = Info_ValueForKey(str, "t");
	team = atoi(v);
	v = Info_ValueForKey(str, "model");
	Q_strncpyz( modelName, v, sizeof( modelName ) );

	slash = strchr( modelName, '/' );
	if ( !slash ) {
		// modelName did not include a skin name
		Q_strncpyz( skinName, "default", sizeof( skinName ) );
	} else {
		Q_strncpyz( skinName, slash + 1, sizeof( skinName ) );
		// truncate modelName
		*slash = 0;
	}

	// fix for transparent custom skin parts
	if (strchr(skinName, '|')
		&& strstr(skinName,"head")
		&& strstr(skinName,"torso")
		&& strstr(skinName,"lower"))
	{//three part skin
		torsoSkin = re.RegisterSkin(va("models/players/%s/|%s", modelName, skinName));
	} else {
		if (team == TEAM_RED) {
			Q_strncpyz(skinName, "red", sizeof(skinName));
		} else if (team == TEAM_BLUE) {
			Q_strncpyz(skinName, "blue", sizeof(skinName));
		}
		torsoSkin = re.RegisterSkin(va("models/players/%s/model_%s.skin", modelName, skinName));
	}
	re.G2API_InitGhoul2Model((CGhoul2Info_v **)&ghoul2, va("models/players/%s/model.glm", modelName), 0, torsoSkin, 0, 0, 0);
}

static void demoPrecache( void ) {
	demoPlay_t *play = demo.play.handle;
	int latestSequence = 0, time = play->startTime;
	demoPlaySetIndex(play, 0);
	Com_SetLoadingMsg("Precaching the demo...");
	while (!play->lastFrame) {
		demoPlaySynch( play, play->frame );
		while (latestSequence < play->commandCount) {
			if (demoGetServerCommand(++latestSequence)) {
				if ( !Q_stricmp( Cmd_Argv(0), "cs" ) ) {
					int num = atoi( Cmd_Argv(1) );
					char *str = cl.gameState.stringData + cl.gameState.stringOffsets[num];
					if ( num >= CS_MODELS && num < CS_MODELS+MAX_MODELS ) {
						demoPrecacheModel(str);
					} else if ( num >= CS_SOUNDS && num < CS_SOUNDS+MAX_SOUNDS && (str[0] || str[1] == '$') ) {
						if ( str[0] != '*' ) S_StartSound(vec3_origin, 0, CHAN_AUTO, -1, S_RegisterSound( str ));
					} else if ( num >= CS_PLAYERS && num < CS_PLAYERS+MAX_CLIENTS ) {
						demoPrecacheClient(str);
					}	
				}
			}
		}
		time += 50;
		while (!play->lastFrame && time > play->nextFrame->serverTime)
			demoPlayForwardFrame(play);
	}
	S_Update();
	S_StopAllSounds();
	demoPlaySetIndex(play, 0);
}

qboolean demoPlayBegin( const char *fileName, qboolean del ) {
	demo.play.handle = demoPlayOpen( fileName );
	if (demo.play.handle) {
		demoPlay_t *play = demo.play.handle;
		clc.demoplaying = qtrue;
		clc.newDemoPlayer = qtrue;
		clc.serverMessageSequence = 0;
		clc.lastExecutedServerCommand = 0;
		Com_Printf("Opened %s, which has %d seconds and %d frames\n", fileName, (play->endTime - play->startTime) / 1000, play->totalFrames );
		Con_Close();
		
		// wipe local client state
		CL_ClearState();
		cls.state = CA_LOADING;
		// Pump the loop, this may change gamestate!
		Com_EventLoop();
		// starting to load a map so we get out of full screen ui mode
		Cvar_Set("r_uiFullScreen", "0");
		// Populate gamestate before CL_FlushMemory so FS_WasmPrepareDemoPaks can inspect CS_SYSTEMINFO / CS_SERVERINFO
		Com_Memcpy( cl.gameState.stringOffsets, play->frame->string.offsets, sizeof( play->frame->string.offsets ));
		Com_Memcpy( cl.gameState.stringData, play->frame->string.data, play->frame->string.used );
		cl.gameState.dataCount = play->frame->string.used;
#ifdef __EMSCRIPTEN__
		{
			extern void CL_WasmPrepareCurrentGamestatePaks( void );
			CL_WasmPrepareCurrentGamestatePaks();
		}
#endif
		// flush client memory and start loading stuff
		// this will also (re)load the UI
		// if this is a local client then only the client part of the hunk
		// will be cleared, note that this is done after the hunk mark has been set
		CL_FlushMemory();
		// initialize the CGame
		cls.cgameStarted = qtrue;
		// Create the gamestate
		Com_Memcpy( cl.gameState.stringOffsets, play->frame->string.offsets, sizeof( play->frame->string.offsets ));
		Com_Memcpy( cl.gameState.stringData, play->frame->string.data, play->frame->string.used );
		cl.gameState.dataCount = play->frame->string.used;
		if (mme_demoPrecache->integer) {
			demo.precaching = qtrue;
			demoPrecache();
		}
		demo.precaching = qfalse;
		demo.del = del;
		return qtrue;
	}
	return qfalse;
}

qboolean demoPlay( const char *fileName, qboolean del ) {
	if ( demoPlayBegin( fileName, del ) ) {
		CL_InitCGame();
		cls.state = CA_ACTIVE;
		return qtrue;
	} else if (demo.nextNum) {
		return qtrue;
	} else {
		return qfalse;
	}
}

void CL_MMEDemo_f( void ) {
	const char *cmd = Cmd_Argv( 1 );

	if (Cmd_Argc() == 2) {
		char mmeName[MAX_OSPATH];
		Com_sprintf (mmeName, MAX_OSPATH, "mmedemos/%s.mme", cmd);
		if (FS_FileExists( mmeName )) {
			Cvar_Set( "mme_demoFileName", cmd );
			demoPlay( mmeName );
		} else {
			Com_Printf("%s not found.\n", mmeName );
		}
		return;
	}
	if (!Q_stricmp( cmd, "convert")) {
		demoConvert( Cmd_Argv( 2 ), Cmd_Argv( 3 ), (qboolean)mme_demoSmoothen->integer );
	} else if (!Q_stricmp( cmd, "play")) {
		demoPlay( Cmd_Argv( 2 ) );
	} else {
		Com_Printf("That does not compute...%s\n", cmd );
	}
}

void CL_DemoList_f(void) {
	int len, i;
	char *buf;
	char word[MAX_OSPATH];
	int	index;
	qboolean readName;
	qboolean haveQuote;

	demo.list.count = 0;
	demo.list.index = 0;
	haveQuote = qfalse;

	if (Cmd_Argc() < 2) {
		Com_Printf( "Usage demoList filename.\n");
		Com_Printf( "That file should have lines with demoname projectname.\n" );
		Com_Printf( "These will be played after each other.\n" );
	}
	if (!FS_FileExists( Cmd_Argv(1))) {
		Com_Printf( "Listfile %s doesn't exist\n", Cmd_Argv(1));
		return;
	}
	len = FS_ReadFile( Cmd_Argv(1), (void **)&buf);
	if (!buf) {
		Com_Printf("file %s couldn't be opened\n", Cmd_Argv(1));
		return;
	}
	i = 0;
	index = 0;
	readName = qtrue;
	while( i < len) {
		switch (buf[i]) {
		case '\r':
			break;
		case '"':
			if (!haveQuote) {
				haveQuote = qtrue;
				break;
			}
		case '\n':
		case ' ':
		case '\t':
			if (haveQuote && buf[i] != '"') {
				if (index < (sizeof(word)-1)) {
	              word[index++] = buf[i];  
				}
				break;
			}
			if (!index)
				break;
			haveQuote = qfalse;
			word[index++] = 0;
			if (readName) {
				Com_Memcpy( demo.list.entry[demo.list.count].demoName, word, index );
				readName = qfalse;
			} else {
				if (demo.list.count < DEMOLISTSIZE) {
					Com_Memcpy( demo.list.entry[demo.list.count].projectName, word, index );
					demo.list.count++;
				}
				readName = qtrue;
			}
			index = 0;
			break;
		default:
			if (index < (sizeof(word)-1)) {
              word[index++] = buf[i];  
			}
			break;
		}
		i++;
	}
	/* Handle a final line if any */
	if (!readName && index && demo.list.count < DEMOLISTSIZE) {
		word[index++] = 0;
		Com_Memcpy( demo.list.entry[demo.list.count].projectName, word, index );
		demo.list.count++;
	}

	FS_FreeFile ( buf );
	demo.list.index = 0;
}

void CL_DemoListNext_f(void) {
	if ( demo.list.index < demo.list.count ) {
		const demoListEntry_t *entry = &demo.list.entry[demo.list.index++];
		Cvar_Set( "mme_demoStartProject", entry->projectName );
		Com_Printf( "Starting demo %s with project %s\n",
			entry->demoName, entry->projectName );
		Cmd_ExecuteString( va( "demo \"%s\"\n", entry->demoName ));
	} else if (demo.list.count) {
		Com_Printf( "DemoList:Finished playing %d demos\n", demo.list.count );
		demo.list.count = 0;
		demo.list.index = 0;
		if ( mme_demoListQuit->integer )
			Cbuf_ExecuteText( EXEC_APPEND, "quit" );
	}
	if (mme_demoAutoNext->integer && demo.nextNum) {
		char demoName[MAX_OSPATH];
		if (demo.nextNum == 1) {
			Com_sprintf(demoName, MAX_OSPATH, "%s.1", mme_demoFileName->string);
		} else if (demo.nextNum < 10) {
			Com_sprintf(demoName, strlen(mme_demoFileName->string)-1, mme_demoFileName->string);
			strcat(demoName, va(".%d", demo.nextNum));
		} else if (demo.nextNum < 100) {
			Com_sprintf(demoName, strlen(mme_demoFileName->string)-2, mme_demoFileName->string);
			strcat(demoName, va(".%d", demo.nextNum));
		}
		Cmd_ExecuteString(va("mmeDemo \"%s\"\n", demoName));
	}
}