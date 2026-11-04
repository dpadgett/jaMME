// dm26tomme.cpp -- Fast standalone server-side .dm_26 -> .mme converter & keyframe indexer
// Includes IP-hash sanitization (matching demosanitizer) and raw-bitstream .mme packing.

#include "../codemp/qcommon/q_shared.h"
#include "../codemp/qcommon/qcommon.h"
#include "../codemp/server/server.h"
#include "../codemp/client/client.h"
#include "../codemp/client/cl_demos.h"
#include "../codemp/qcommon/game_version.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdarg.h>
#include <errno.h>
#include <math.h>
#include <unistd.h>

extern qboolean g_msgRawBitstream;

cvar_t cl_shownet_concrete;
cvar_t *cl_shownet = &cl_shownet_concrete;
server_t sv;

sharedEntity_t *SV_GentityNum( int num ) {
	return NULL;
}

void QDECL Com_Error( int code, const char *fmt, ... ) {
	va_list argptr;
	char buf[4096];
	va_start( argptr, fmt );
	vsnprintf( buf, sizeof( buf ), fmt, argptr );
	va_end( argptr );
	fprintf( stderr, "Com_Error(%d): %s\n", code, buf );
	exit( 1 );
}

void QDECL Com_Printf( const char *fmt, ... ) {
	va_list argptr;
	va_start( argptr, fmt );
	vfprintf( stderr, fmt, argptr );
	va_end( argptr );
}

void *Z_Malloc( int iSize, memtag_t eTag, qboolean bZeroit, int unusedAlign ) {
	return bZeroit ? calloc( 1, (size_t)iSize ) : malloc( (size_t)iSize );
}

long QDECL FS_FOpenFileRead( const char *filename, fileHandle_t *fileHandle, qboolean uniqueFILE ) {
	if ( fileHandle ) *fileHandle = 0;
	return 0;
}

int QDECL FS_Read( void *buffer, int len, fileHandle_t f ) {
	return 0;
}

void QDECL FS_FCloseFile( fileHandle_t f ) {
}

void Q_strncpyz( char *dest, const char *src, int destsize ) {
	if ( !dest || destsize < 1 ) return;
	if ( !src ) {
		dest[0] = 0;
		return;
	}
	strncpy( dest, src, (size_t)( destsize - 1 ) );
	dest[destsize - 1] = 0;
}

int Q_stricmpn( const char *s1, const char *s2, int n ) {
	return strncasecmp( s1, s2, (size_t)n );
}

int Q_stricmp( const char *s1, const char *s2 ) {
	return strcasecmp( s1, s2 );
}

void Q_strcat( char *dest, int size, const char *src ) {
	int l1 = (int)strlen( dest );
	if ( l1 >= size ) return;
	Q_strncpyz( dest + l1, src, size - l1 );
}

int QDECL Com_sprintf( char *dest, int size, const char *fmt, ... ) {
	int len;
	va_list argptr;
	va_start( argptr, fmt );
	len = vsnprintf( dest, (size_t)size, fmt, argptr );
	va_end( argptr );
	if ( size > 0 ) dest[size - 1] = 0;
	return len;
}

char * QDECL va( const char *format, ... ) {
	va_list argptr;
	static char string[2][32000];
	static int index = 0;
	char *buf = string[index & 1];
	index++;
	va_start( argptr, format );
	vsnprintf( buf, 32000, format, argptr );
	va_end( argptr );
	return buf;
}

char *Info_ValueForKey( const char *s, const char *key ) {
	char pkey[BIG_INFO_KEY];
	static char value[2][BIG_INFO_VALUE];
	static int valueindex = 0;
	char *o;

	if ( !s || !key ) return "";
	if ( strlen( s ) >= BIG_INFO_STRING ) return "";

	valueindex ^= 1;
	if ( *s == '\\' ) s++;
	while ( 1 ) {
		o = pkey;
		while ( *s != '\\' ) {
			if ( !*s ) return "";
			*o++ = *s++;
		}
		*o = 0;
		s++;

		o = value[valueindex];
		while ( *s != '\\' && *s ) {
			*o++ = *s++;
		}
		*o = 0;

		if ( !Q_stricmp( key, pkey ) ) return value[valueindex];
		if ( !*s ) break;
		s++;
	}
	return "";
}

static void Info_SetValueForKey_BigInplace( char *s, const char *key, const char *newvalue ) {
	char newi[BIG_INFO_STRING], orig[BIG_INFO_STRING];
	const char *blacklist = "\\;\"";

	if ( strlen( s ) >= BIG_INFO_STRING ) return;
	for ( ; *blacklist; ++blacklist ) {
		if ( strchr( key, *blacklist ) || strchr( newvalue, *blacklist ) ) return;
	}
	Com_sprintf( newi, sizeof( newi ), "\\%s\\%s", key, newvalue );

	char *start, *param;
	static char pkey[BIG_INFO_KEY], value[BIG_INFO_VALUE];
	char *o;

	pkey[0] = value[0] = '\0';
	Q_strncpyz( orig, s, sizeof( orig ) );
	param = s;
	if ( strchr( key, '\\' ) ) return;

	while ( 1 ) {
		start = s;
		if ( *s == '\\' ) s++;
		o = pkey;
		while ( *s != '\\' ) {
			if ( !*s ) return;
			*o++ = *s++;
		}
		*o = 0;
		s++;

		o = value;
		while ( *s != '\\' && *s ) {
			if ( !*s ) return;
			*o++ = *s++;
		}
		*o = 0;

		if ( !strcmp( key, pkey ) ) {
			if ( strlen( orig ) - (size_t)( s - start ) + strlen( newi ) >= BIG_INFO_STRING ) {
				memmove( start, s, strlen( s ) + 1 );
				return;
			}
			memmove( start, newi, strlen( newi ) );
			memmove( start + strlen( newi ), orig + ( s - param ), strlen( orig + ( s - param ) ) + 1 );
			return;
		}
		if ( !*s ) return;
	}
}

static qboolean StripIpHash( char *s ) {
	char *id = Info_ValueForKey( s, "id" );
	if ( id[0] == '\0' ) return qfalse;
	char *p = NULL;
	errno = 0;
	unsigned long long uniqueId = strtoull( id, &p, 10 );
	if ( errno == ERANGE || *p != 0 || p == id ) {
		uniqueId = 0;
	}
	unsigned int guid_hash = (unsigned int)( uniqueId & 0xFFFFFFFFull );
	uniqueId = (unsigned long long)guid_hash;
	Info_SetValueForKey_BigInplace( s, "id", va( "%llu", uniqueId ) );
	return qtrue;
}

// Simple command tokenizer matching qcommon/cmd.cpp
static int cmd_argc;
static char *cmd_argv[MAX_STRING_TOKENS];
static char cmd_tokenized[BIG_INFO_STRING + MAX_STRING_CHARS];
static char cmd_cmd[BIG_INFO_STRING + MAX_STRING_CHARS];

int Cmd_Argc( void ) { return cmd_argc; }
char *Cmd_Argv( int arg ) {
	if ( (unsigned)arg >= (unsigned)cmd_argc ) return "";
	return cmd_argv[arg];
}
char *Cmd_ArgsFrom( int arg ) {
	static char cmd_args[BIG_INFO_STRING];
	int i;
	cmd_args[0] = 0;
	if ( arg < 0 ) arg = 0;
	for ( i = arg; i < cmd_argc; i++ ) {
		Q_strcat( cmd_args, sizeof( cmd_args ), cmd_argv[i] );
		if ( i != cmd_argc - 1 ) {
			Q_strcat( cmd_args, sizeof( cmd_args ), " " );
		}
	}
	return cmd_args;
}

void Cmd_TokenizeString( const char *text_in ) {
	const char *text;
	char *textOut;

	cmd_argc = 0;
	if ( !text_in ) return;

	Q_strncpyz( cmd_cmd, text_in, sizeof( cmd_cmd ) );
	text = cmd_cmd;
	textOut = cmd_tokenized;

	while ( 1 ) {
		if ( cmd_argc == MAX_STRING_TOKENS ) return;
		while ( 1 ) {
			while ( *text && *text <= ' ' ) {
				text++;
			}
			if ( !*text ) return;
			if ( text[0] == '/' && text[1] == '/' ) return;
			if ( text[0] == '/' && text[1] == '*' ) {
				while ( *text && ( text[0] != '*' || text[1] != '/' ) ) {
					text++;
				}
				if ( !*text ) return;
				text += 2;
			} else {
				break;
			}
		}

		if ( *text == '"' ) {
			cmd_argv[cmd_argc++] = textOut;
			text++;
			while ( *text && *text != '"' ) {
				*textOut++ = *text++;
			}
			*textOut++ = 0;
			if ( !*text ) return;
			text++;
			continue;
		}

		cmd_argv[cmd_argc++] = textOut;
		while ( *text > ' ' ) {
			if ( text[0] == '"' ) break;
			if ( text[0] == '/' && text[1] == '/' ) break;
			if ( text[0] == '/' && text[1] == '*' ) break;
			*textOut++ = *text++;
		}
		*textOut++ = 0;
		if ( !*text ) return;
	}
}

float LerpAngle( float from, float to, float frac ) {
	float a;
	if ( to - from > 180 ) {
		to -= 360;
	}
	if ( to - from < -180 ) {
		to += 360;
	}
	a = from + frac * ( to - from );
	return a;
}

void LerpOrigin( const vec3_t from, const vec3_t to, vec3_t out, float frac ) {
	out[0] = from[0] + frac * ( to[0] - from[0] );
	out[1] = from[1] + frac * ( to[1] - from[1] );
	out[2] = from[2] + frac * ( to[2] - from[2] );
}

void LerpAngles( const vec3_t from, const vec3_t to, vec3_t out, float frac ) {
	out[0] = LerpAngle( from[0], to[0], frac );
	out[1] = LerpAngle( from[1], to[1], frac );
	out[2] = LerpAngle( from[2], to[2], frac );
}

static entityState_t demoNullEntityState;
static playerState_t demoNullPlayerState;
static const char *demoHeader = JK_VERSION " Demo";
static byte demoBuffer[128 * 1024];
static qboolean demoFirstPack = qtrue;
static byte s_frameEntityValid[DEMOCONVERTFRAMES][MAX_GENTITIES];
static int s_frameMaxEntity[DEMOCONVERTFRAMES];
static int s_frameStringSeq[DEMOCONVERTFRAMES];
static int s_currentStringSeq = 1;

static void demoFrameAddString( demoString_t *string, int num, const char *newString ) {
	int dataLeft, len;
	int i;
	char cache[sizeof( string->data )];
	char sanitized[BIG_INFO_STRING];

	if ( num < 0 || num >= MAX_CONFIGSTRINGS || !newString ) return;

	if ( num >= CS_PLAYERS && num < CS_PLAYERS + MAX_CLIENTS && newString[0] ) {
		Q_strncpyz( sanitized, newString, sizeof( sanitized ) );
		StripIpHash( sanitized );
		newString = sanitized;
	}

	if ( !newString[0] ) {
		string->offsets[num] = 0;
		return;
	}
	len = (int)strlen( newString ) + 1;
	dataLeft = (int)sizeof( string->data ) - string->used;
	if ( len <= dataLeft ) {
		Com_Memcpy( string->data + string->used, newString, (size_t)len );
		string->offsets[num] = string->used;
		string->used += len;
		return;
	}
	cache[0] = 0;
	string->used = 1;
	for ( i = 0; i < MAX_CONFIGSTRINGS; i++ ) {
		const char *s = ( i == num ) ? newString : string->data + string->offsets[i];
		if ( !s[0] ) {
			string->offsets[i] = 0;
			continue;
		}
		dataLeft = (int)sizeof( cache ) - string->used;
		len = (int)strlen( s ) + 1;
		if ( len >= dataLeft ) {
			return;
		}
		Com_Memcpy( cache + string->used, s, (size_t)len );
		string->offsets[i] = string->used;
		string->used += len;
	}
	Com_Memcpy( string->data, cache, (size_t)string->used );
}

static void demoFramePack( msg_t *msg, const demoFrame_t *newFrame, const demoFrame_t *oldFrame, int newSlot, int oldSlot, qboolean *firstPack ) {
	int i;
	MSG_WriteBits( msg, oldFrame ? 0 : 1, 1 );
	MSG_WriteLong( msg, newFrame->serverTime );
	if ( !oldFrame || s_frameStringSeq[oldSlot] != s_frameStringSeq[newSlot] ) {
		for ( i = 0; i < MAX_CONFIGSTRINGS; i++ ) {
			if ( ( !oldFrame || !oldFrame->string.offsets[i] ) && !newFrame->string.offsets[i] ) {
				continue;
			}
			const char *oldString = !oldFrame ? "" : &oldFrame->string.data[oldFrame->string.offsets[i]];
			const char *newString = newFrame->string.data + newFrame->string.offsets[i];
			if ( strcmp( oldString, newString ) ) {
				MSG_WriteShort( msg, i );
				MSG_WriteBigString( msg, newString );
			}
		}
	}
	MSG_WriteShort( msg, MAX_CONFIGSTRINGS );
	for ( i = 0; i < MAX_CLIENTS; i++ ) {
		const playerState_t *oldPlayer, *newPlayer;
		const playerState_t *oldVeh, *newVeh;
		if ( !newFrame->clientData[i] )
			continue;
		oldPlayer = ( !oldFrame || !oldFrame->clientData[i] ) ? &demoNullPlayerState : &oldFrame->clients[i];
		newPlayer = &newFrame->clients[i];
		MSG_WriteByte( msg, i );
		MSG_WriteDeltaPlayerstate( msg, (playerState_t *)oldPlayer, (playerState_t *)newPlayer );
		if ( newPlayer->m_iVehicleNum ) {
			oldVeh = ( !oldFrame || !oldFrame->clientData[i] ) ? &demoNullPlayerState : &oldFrame->vehs[i];
			newVeh = &newFrame->vehs[i];
			MSG_WriteDeltaPlayerstate( msg, (playerState_t *)oldVeh, (playerState_t *)newVeh, qtrue );
		}
	}
	MSG_WriteByte( msg, MAX_CLIENTS );
	{
		const byte *newValid = s_frameEntityValid[newSlot];
		const byte *oldValid = oldFrame ? s_frameEntityValid[oldSlot] : NULL;
		int maxEnt = s_frameMaxEntity[newSlot];
		if ( oldFrame && s_frameMaxEntity[oldSlot] > maxEnt ) {
			maxEnt = s_frameMaxEntity[oldSlot];
		}
		if ( maxEnt >= MAX_GENTITIES - 1 ) {
			maxEnt = MAX_GENTITIES - 2;
		}
		for ( i = 0; i <= maxEnt; i++ ) {
			byte nv = newValid[i];
			byte ov = oldValid ? oldValid[i] : 0;
			if ( !ov && !nv ) {
				continue;
			}
			const entityState_t *oldEntity = ov ? &oldFrame->entities[i] : ( nv ? &demoNullEntityState : NULL );
			const entityState_t *newEntity = nv ? &newFrame->entities[i] : NULL;
			if ( ov && nv && !memcmp( oldEntity, newEntity, sizeof( entityState_t ) ) ) {
				continue;
			}
			MSG_WriteDeltaEntity( msg, (entityState_t *)oldEntity, (entityState_t *)newEntity, (qboolean)( !ov ) );
		}
	}
	MSG_WriteBits( msg, ( MAX_GENTITIES - 1 ), GENTITYNUM_BITS );
	MSG_WriteByte( msg, newFrame->areaUsed );
	MSG_WriteData( msg, newFrame->areamask, newFrame->areaUsed );
	MSG_WriteLong( msg, newFrame->commandUsed );
	MSG_WriteData( msg, newFrame->commandData, newFrame->commandUsed );
	if ( *firstPack ) {
		for ( i = 0; i < MAX_GENTITIES; i++ ) {
			const entityState_t *newEntity = &newFrame->entityBaselines[i];
			if ( !newEntity->number ) {
				continue;
			}
			MSG_WriteByte( msg, svc_baseline );
			MSG_WriteDeltaEntity( msg, &demoNullEntityState, (entityState_t *)newEntity, qtrue );
		}
		MSG_WriteByte( msg, svc_EOF );
		*firstPack = qfalse;
	}
}

static void demoFrameInterpolate( demoFrame_t frames[], int frameCount, int index ) {
	int i;
	int workSlot = index % frameCount;
	demoFrame_t *workFrame = &frames[workSlot];

	for ( i = 0; i < MAX_CLIENTS; i++ ) {
		entityState_t *workEntity = &workFrame->entities[i];
		if ( s_frameEntityValid[workSlot][i] && !workFrame->entityData[i] ) {
			int m;
			demoFrame_t *prevFrame = 0, *nextFrame = 0;
			for ( m = index - 1; ( m > ( index - frameCount ) ) && m > 0; m-- ) {
				int testSlot = m % frameCount;
				demoFrame_t *testFrame = &frames[testSlot];
				if ( !testFrame->entityData[i] ) continue;
				if ( !testFrame->serverTime || testFrame->serverTime >= workFrame->serverTime ) break;
				if ( !s_frameEntityValid[testSlot][i] ) break;
				if ( ( testFrame->entities[i].eFlags ^ workEntity->eFlags ) & EF_TELEPORT_BIT ) break;
				prevFrame = testFrame;
				break;
			}
			for ( m = index + 1; ( m < ( index + frameCount ) ); m++ ) {
				int testSlot = m % frameCount;
				demoFrame_t *testFrame = &frames[testSlot];
				if ( !testFrame->entityData[i] ) continue;
				if ( !testFrame->serverTime || testFrame->serverTime <= workFrame->serverTime ) break;
				if ( !s_frameEntityValid[testSlot][i] ) break;
				if ( ( testFrame->entities[i].eFlags ^ workEntity->eFlags ) & EF_TELEPORT_BIT ) break;
				nextFrame = testFrame;
				break;
			}
			if ( prevFrame && nextFrame ) {
				const entityState_t *prevEntity = &prevFrame->entities[i];
				const entityState_t *nextEntity = &nextFrame->entities[i];
				int prevTime = prevFrame->serverTime;
				int nextTime = nextFrame->serverTime;
				float lerp = ( workFrame->serverTime - prevTime ) / (float)( nextTime - prevTime );
				int posDelta = nextEntity->pos.trTime - prevEntity->pos.trTime;
				float posLerp;
				if ( posDelta ) {
					workEntity->pos.trTime = prevEntity->pos.trTime + posDelta * lerp;
					posLerp = ( workEntity->pos.trTime - prevEntity->pos.trTime ) / (float)posDelta;
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
	int fileSize;
	int totalFrames;
	int startTime;
	int endTime;
	int fileIndexCount;
	struct {
		int pos, time, frame;
	} fileIndex[DEMO_MAX_INDEX];
} mmeIndex_t;

static mmeIndex_t s_mmeIndex;

static void emitFrame( FILE *outFp, const demoFrame_t *newFrame, const demoFrame_t *oldFrame, int newSlot, int oldSlot ) {
	msg_t writeMsg;
	int temp;
	MSG_Init( &writeMsg, demoBuffer, sizeof( demoBuffer ) );
	MSG_Clear( &writeMsg );
	MSG_Bitstream( &writeMsg );
	g_msgRawBitstream = qtrue;
	demoFramePack( &writeMsg, newFrame, oldFrame, newSlot, oldSlot, &demoFirstPack );
	g_msgRawBitstream = qfalse;

	if ( !s_mmeIndex.startTime ) {
		s_mmeIndex.startTime = newFrame->serverTime;
	}
	if ( !oldFrame && s_mmeIndex.fileIndexCount < DEMO_MAX_INDEX ) {
		s_mmeIndex.fileIndex[s_mmeIndex.fileIndexCount].pos = s_mmeIndex.fileSize;
		s_mmeIndex.fileIndex[s_mmeIndex.fileIndexCount].frame = s_mmeIndex.totalFrames;
		s_mmeIndex.fileIndex[s_mmeIndex.fileIndexCount].time = newFrame->serverTime;
		s_mmeIndex.fileIndexCount++;
	}
	int prevSize = s_mmeIndex.fileSize;
	s_mmeIndex.endTime = newFrame->serverTime;
	s_mmeIndex.fileSize += 4 + writeMsg.cursize;
	s_mmeIndex.totalFrames++;

	temp = LittleLong( writeMsg.cursize );
	fwrite( &temp, 4, 1, outFp );
	fwrite( writeMsg.data, 1, (size_t)writeMsg.cursize, outFp );
	if ( s_mmeIndex.totalFrames == 2 || ( prevSize < 524288 && s_mmeIndex.fileSize >= 524288 ) || ( ( prevSize >> 19 ) != ( s_mmeIndex.fileSize >> 19 ) ) ) {
		fflush( outFp );
	}
}

int main( int argc, char **argv ) {
	if ( argc < 4 ) {
		fprintf( stderr, "Usage: %s <input.dm_26> <output.mme> <output.meta.json>\n", argv[0] );
		return 1;
	}
	const char *inPath = argv[1];
	const char *outMmePath = argv[2];
	const char *outMetaPath = argv[3];

	FILE *inFp = ( !strcmp( inPath, "-" ) ) ? stdin : fopen( inPath, "rb" );
	if ( !inFp ) {
		fprintf( stderr, "Failed to open input: %s\n", inPath );
		return 1;
	}
	static char inIoBuf[262144];
	setvbuf( inFp, inIoBuf, _IOFBF, sizeof( inIoBuf ) );

	FILE *outFp = fopen( outMmePath, "wb" );
	if ( !outFp ) {
		if ( inFp != stdin ) fclose( inFp );
		fprintf( stderr, "Failed to open output: %s\n", outMmePath );
		return 1;
	}
	static char outIoBuf[262144];
	setvbuf( outFp, outIoBuf, _IOFBF, sizeof( outIoBuf ) );

	demoConvert_t *convert = (demoConvert_t *)calloc( 1, sizeof( demoConvert_t ) );
	if ( !convert ) {
		if ( inFp != stdin ) fclose( inFp );
		fclose( outFp );
		return 1;
	}

	static byte oldData[MAX_MSGLEN];
	static char bigConfigString[BIG_INFO_STRING];
	int bigConfigNumber = 0;
	int msgSequence = 0;
	int oldTime = -1;
	int fullTime = -1;
	int clientNum = -1;
	int parseEntitiesNum = 0;
	int levelCount = 0;
	qboolean smoothen = qtrue;
	char mapName[MAX_QPATH] = "";

	msg_t oldMsg;
	demoFrame_t *workFrame;
	clSnapshot_t *oldSnap, *newSnap;
	int nextTime, temp, i;
	const char *s;
	unsigned short rmgDataSize, flatDataSize, automapCount;

	while ( 1 ) {
		MSG_Init( &oldMsg, oldData, sizeof( oldData ) );
		if ( fread( &convert->messageNum, 4, 1, inFp ) != 1 ) break;
		if ( fread( &oldMsg.cursize, 4, 1, inFp ) != 1 ) break;
		oldMsg.cursize = LittleLong( oldMsg.cursize );
		if ( convert->messageNum == -1 && oldMsg.cursize == -1 ) {
			break;
		}
		if ( oldMsg.cursize < 0 || oldMsg.cursize > oldMsg.maxsize ) {
			break;
		}
		if ( (int)fread( oldMsg.data, 1, (size_t)oldMsg.cursize, inFp ) != oldMsg.cursize ) {
			break;
		}

		MSG_BeginReading( &oldMsg );
		MSG_ReadLong( &oldMsg ); // reliableAcknowledge

		while ( 1 ) {
			byte cmd;
			if ( oldMsg.readcount > oldMsg.cursize ) {
				goto done_loop;
			}
			cmd = (byte)MSG_ReadByte( &oldMsg );
			if ( cmd == svc_EOF ) {
				break;
			}
			workFrame = &convert->frames[convert->frameIndex % DEMOCONVERTFRAMES];
			switch ( cmd ) {
			default:
				goto done_loop;
			case svc_nop:
				break;
			case svc_serverCommand:
				temp = MSG_ReadLong( &oldMsg );
				s = MSG_ReadString( &oldMsg );
				if ( temp <= msgSequence )
					break;
				msgSequence = temp;
				Cmd_TokenizeString( s );
				if ( !Q_stricmp( Cmd_Argv( 0 ), "bcs0" ) ) {
					bigConfigNumber = atoi( Cmd_Argv( 1 ) );
					Q_strncpyz( bigConfigString, Cmd_Argv( 2 ), BIG_INFO_STRING );
					break;
				}
				if ( !Q_stricmp( Cmd_Argv( 0 ), "bcs1" ) ) {
					Q_strcat( bigConfigString, BIG_INFO_STRING, Cmd_Argv( 2 ) );
					break;
				}
				if ( !Q_stricmp( Cmd_Argv( 0 ), "bcs2" ) ) {
					Q_strcat( bigConfigString, BIG_INFO_STRING, Cmd_Argv( 2 ) );
					demoFrameAddString( &workFrame->string, bigConfigNumber, bigConfigString );
					s_frameStringSeq[convert->frameIndex % DEMOCONVERTFRAMES] = ++s_currentStringSeq;
					break;
				}
				if ( !Q_stricmp( Cmd_Argv( 0 ), "cs" ) ) {
					int num = atoi( Cmd_Argv( 1 ) );
					demoFrameAddString( &workFrame->string, num, Cmd_ArgsFrom( 2 ) );
					s_frameStringSeq[convert->frameIndex % DEMOCONVERTFRAMES] = ++s_currentStringSeq;
					break;
				}
				if ( clientNum >= 0 && clientNum < MAX_CLIENTS ) {
					int len = (int)strlen( s ) + 1;
					char *dst;
					if ( workFrame->commandUsed + len + 1 > (int)sizeof( workFrame->commandData ) ) {
						goto done_loop;
					}
					dst = workFrame->commandData + workFrame->commandUsed;
					*dst = (char)clientNum;
					Com_Memcpy( dst + 1, s, (size_t)len );
					workFrame->commandUsed += len + 1;
				}
				break;
			case svc_gamestate:
				if ( levelCount >= 1 && convert->frameIndex > 0 ) {
					// First level is complete; flush and finish
					goto done_loop;
				}
				fullTime = -1;
				clientNum = -1;
				oldTime = -1;
				demoFirstPack = qtrue;
				Com_Memset( convert, 0, sizeof( *convert ) );
				Com_Memset( s_frameEntityValid, 0, sizeof( s_frameEntityValid ) );
				for ( i = 0; i < DEMOCONVERTFRAMES; i++ ) {
					s_frameMaxEntity[i] = -1;
					s_frameStringSeq[i] = 0;
				}
				s_currentStringSeq = 1;
				s_frameStringSeq[0] = s_currentStringSeq;
				convert->frames[0].string.used = 1;
				levelCount = 1;

				fseek( outFp, 0, SEEK_SET );
				{
					int hdrLen = (int)strlen( demoHeader );
					fwrite( demoHeader, 1, (size_t)hdrLen, outFp );
					Com_Memset( &s_mmeIndex, 0, sizeof( s_mmeIndex ) );
					s_mmeIndex.fileSize = hdrLen;
				}

				workFrame = &convert->frames[convert->frameIndex % DEMOCONVERTFRAMES];
				msgSequence = MSG_ReadLong( &oldMsg );
				while ( 1 ) {
					cmd = (byte)MSG_ReadByte( &oldMsg );
					if ( cmd == svc_EOF ) break;
					if ( cmd == svc_configstring ) {
						int num = MSG_ReadShort( &oldMsg );
						const char *cs = MSG_ReadBigString( &oldMsg );
						if ( num == CS_SERVERINFO && cs && cs[0] ) {
							const char *m = Info_ValueForKey( cs, "mapname" );
							if ( m && m[0] ) Q_strncpyz( mapName, m, sizeof( mapName ) );
						}
						demoFrameAddString( &workFrame->string, num, cs );
					} else if ( cmd == svc_baseline ) {
						int num = MSG_ReadBits( &oldMsg, GENTITYNUM_BITS );
						if ( num < 0 || num >= MAX_GENTITIES ) {
							goto done_loop;
						}
						MSG_ReadDeltaEntity( &oldMsg, &demoNullEntityState, &convert->entityBaselines[num], num );
						memcpy( &workFrame->entityBaselines[num], &convert->entityBaselines[num], sizeof( entityState_t ) );
					} else {
						goto done_loop;
					}
				}
				clientNum = MSG_ReadLong( &oldMsg );
				MSG_ReadLong( &oldMsg ); // checksumFeed
				rmgDataSize = (unsigned short)MSG_ReadShort( &oldMsg );
				if ( rmgDataSize != 0 ) {
					unsigned char dataBuffer[MAX_HEIGHTMAP_SIZE];
					MSG_ReadBits( &oldMsg, 1 );
					MSG_ReadData( &oldMsg, dataBuffer, rmgDataSize );
					flatDataSize = (unsigned short)MSG_ReadShort( &oldMsg );
					MSG_ReadBits( &oldMsg, 1 );
					MSG_ReadData( &oldMsg, dataBuffer, flatDataSize );
					MSG_ReadLong( &oldMsg );
					automapCount = (unsigned short)MSG_ReadShort( &oldMsg );
					for ( i = 0; i < automapCount; i++ ) {
						MSG_ReadByte( &oldMsg );
						MSG_ReadByte( &oldMsg );
						MSG_ReadLong( &oldMsg );
						MSG_ReadLong( &oldMsg );
					}
				}
				break;
			case svc_snapshot:
				nextTime = MSG_ReadLong( &oldMsg );
				newSnap = &convert->snapshots[convert->messageNum & PACKET_MASK];
				Com_Memset( newSnap, 0, sizeof( *newSnap ) );
				newSnap->deltaNum = MSG_ReadByte( &oldMsg );
				newSnap->messageNum = convert->messageNum;
				if ( !newSnap->deltaNum ) {
					newSnap->deltaNum = -1;
					newSnap->valid = qtrue;
					oldSnap = NULL;
				} else {
					newSnap->deltaNum = newSnap->messageNum - newSnap->deltaNum;
					oldSnap = &convert->snapshots[newSnap->deltaNum & PACKET_MASK];
					if ( !oldSnap->valid ) {
					} else if ( oldSnap->messageNum != newSnap->deltaNum ) {
					} else if ( parseEntitiesNum - oldSnap->parseEntitiesNum > MAX_PARSE_ENTITIES - 128 ) {
					} else {
						newSnap->valid = qtrue;
					}
				}
				newSnap->snapFlags = MSG_ReadByte( &oldMsg );
				workFrame->areaUsed = (byte)MSG_ReadByte( &oldMsg );
				MSG_ReadData( &oldMsg, workFrame->areamask, workFrame->areaUsed );
				if ( clientNum < 0 || clientNum >= MAX_CLIENTS ) {
					goto done_loop;
				}
				MSG_ReadDeltaPlayerstate( &oldMsg, oldSnap ? &oldSnap->ps : &demoNullPlayerState, &newSnap->ps );
				if ( newSnap->ps.m_iVehicleNum )
					MSG_ReadDeltaPlayerstate( &oldMsg, oldSnap ? &oldSnap->vps : &demoNullPlayerState, &newSnap->vps, qtrue );
				newSnap->parseEntitiesNum = parseEntitiesNum;
				newSnap->numEntities = 0;
				Com_Memset( workFrame->entityData, 0, sizeof( workFrame->entityData ) );
				{
					int newnum = MSG_ReadBits( &oldMsg, GENTITYNUM_BITS );
					entityState_t *oldstate, *newstate;
					int oldindex = 0;
					int oldnum;
					while ( 1 ) {
						if ( oldSnap && oldindex < oldSnap->numEntities ) {
							oldstate = &convert->parseEntities[( oldSnap->parseEntitiesNum + oldindex ) & ( MAX_PARSE_ENTITIES - 1 )];
							oldnum = oldstate->number;
						} else {
							oldstate = 0;
							oldnum = 99999;
						}
						newstate = &convert->parseEntities[parseEntitiesNum];
						if ( !oldstate && ( newnum == ( MAX_GENTITIES - 1 ) ) ) {
							break;
						} else if ( oldnum < newnum ) {
							*newstate = *oldstate;
							oldindex++;
						} else if ( oldnum == newnum ) {
							oldindex++;
							MSG_ReadDeltaEntity( &oldMsg, oldstate, newstate, newnum );
							if ( newstate->number != MAX_GENTITIES - 1 )
								workFrame->entityData[newstate->number] = 1;
							newnum = MSG_ReadBits( &oldMsg, GENTITYNUM_BITS );
						} else if ( oldnum > newnum ) {
							MSG_ReadDeltaEntity( &oldMsg, &convert->entityBaselines[newnum], newstate, newnum );
							if ( newstate->number != MAX_GENTITIES - 1 )
								workFrame->entityData[newstate->number] = 1;
							newnum = MSG_ReadBits( &oldMsg, GENTITYNUM_BITS );
						}
						if ( newstate->number == MAX_GENTITIES - 1 )
							continue;
						parseEntitiesNum++;
						parseEntitiesNum &= ( MAX_PARSE_ENTITIES - 1 );
						newSnap->numEntities++;
					}
				}
				if ( !newSnap->valid )
					break;
				if ( newSnap->messageNum - convert->lastMessageNum >= PACKET_BACKUP ) {
					convert->lastMessageNum = newSnap->messageNum - ( PACKET_BACKUP - 1 );
				}
				for ( ; convert->lastMessageNum < newSnap->messageNum; convert->lastMessageNum++ ) {
					convert->snapshots[convert->lastMessageNum & PACKET_MASK].valid = qfalse;
				}
				convert->lastMessageNum = newSnap->messageNum + 1;

				if ( nextTime > oldTime ) {
					demoFrame_t *cleanFrame;
					int writeIndex;
					int workSlot = convert->frameIndex % DEMOCONVERTFRAMES;
					int maxEnt = -1;
					for ( temp = 0; temp < newSnap->numEntities; temp++ ) {
						int p = ( newSnap->parseEntitiesNum + temp ) & ( MAX_PARSE_ENTITIES - 1 );
						entityState_t *newState = &convert->parseEntities[p];
						int entNum = newState->number;
						if ( entNum >= 0 && entNum < MAX_GENTITIES - 1 ) {
							workFrame->entities[entNum] = *newState;
							s_frameEntityValid[workSlot][entNum] = 1;
							if ( entNum > maxEnt ) maxEnt = entNum;
						}
					}
					s_frameMaxEntity[workSlot] = maxEnt;
					workFrame->clientData[clientNum] = 1;
					workFrame->clients[clientNum] = newSnap->ps;
					workFrame->vehs[clientNum] = newSnap->vps;
					workFrame->serverTime = nextTime;

					writeIndex = convert->frameIndex - ( DEMOCONVERTFRAMES / 2 );
					if ( writeIndex >= 0 ) {
						int newSlot = writeIndex % DEMOCONVERTFRAMES;
						int oldSlot = ( writeIndex - 1 ) % DEMOCONVERTFRAMES;
						const demoFrame_t *newFrame = &convert->frames[newSlot];
						const demoFrame_t *oldFrame = 0;
						if ( smoothen )
							demoFrameInterpolate( convert->frames, DEMOCONVERTFRAMES, writeIndex );
						if ( nextTime > fullTime || writeIndex <= 0 ) {
							fullTime = nextTime + 2000;
						} else {
							oldFrame = &convert->frames[oldSlot];
						}
						emitFrame( outFp, newFrame, oldFrame, newSlot, oldSlot );
					}

					convert->frameIndex++;
					int cleanSlot = convert->frameIndex % DEMOCONVERTFRAMES;
					cleanFrame = &convert->frames[cleanSlot];
					cleanFrame->serverTime = 0;
					Com_Memset( s_frameEntityValid[cleanSlot], 0, sizeof( s_frameEntityValid[cleanSlot] ) );
					s_frameMaxEntity[cleanSlot] = -1;
					Com_Memset( cleanFrame->clientData, 0, sizeof( cleanFrame->clientData ) );
					if ( s_frameStringSeq[cleanSlot] != s_frameStringSeq[workSlot] ) {
						Com_Memcpy( cleanFrame->string.data, workFrame->string.data, (size_t)workFrame->string.used );
						Com_Memcpy( cleanFrame->string.offsets, workFrame->string.offsets, sizeof( workFrame->string.offsets ) );
						cleanFrame->string.used = workFrame->string.used;
						s_frameStringSeq[cleanSlot] = s_frameStringSeq[workSlot];
					}
					cleanFrame->commandUsed = 0;
					oldTime = nextTime;
				}
				break;
			case svc_download:
				temp = MSG_ReadShort( &oldMsg );
				if ( !temp ) MSG_ReadLong( &oldMsg );
				temp = MSG_ReadShort( &oldMsg );
				for ( ; temp > 0; temp-- ) MSG_ReadByte( &oldMsg );
				break;
			case svc_setgame:
				i = 0;
				while ( i < MAX_QPATH ) {
					if ( !MSG_ReadByte( &oldMsg ) ) break;
					i++;
				}
				break;
			case svc_mapchange:
				break;
			}
		}
	}

done_loop:
	if ( convert->frameIndex > 0 ) {
		int flushStart = convert->frameIndex - ( DEMOCONVERTFRAMES / 2 );
		int flushIdx;
		if ( flushStart < 0 ) flushStart = 0;
		for ( flushIdx = flushStart; flushIdx < convert->frameIndex; flushIdx++ ) {
			int newSlot = flushIdx % DEMOCONVERTFRAMES;
			int oldSlot = ( flushIdx - 1 ) % DEMOCONVERTFRAMES;
			const demoFrame_t *newFrame = &convert->frames[newSlot];
			const demoFrame_t *oldFrame = 0;
			if ( newFrame->serverTime > fullTime || flushIdx <= 0 ) {
				fullTime = newFrame->serverTime + 2000;
			} else {
				oldFrame = &convert->frames[oldSlot];
			}
			emitFrame( outFp, newFrame, oldFrame, newSlot, oldSlot );
		}
	}

	fclose( inFp );
	fclose( outFp );
	free( convert );

	if ( s_mmeIndex.totalFrames <= 0 ) {
		return 2;
	}

	char tmpMetaPath[1024];
	snprintf( tmpMetaPath, sizeof( tmpMetaPath ), "%s.tmp.%d", outMetaPath, (int)getpid() );
	FILE *metaFp = fopen( tmpMetaPath, "wb" );
	if ( !metaFp ) {
		return 3;
	}
	fprintf(
		metaFp,
		"{\"fileSize\":%d,\"startTime\":%d,\"endTime\":%d,\"totalFrames\":%d,\"mapName\":\"%s\",\"indexCount\":%d,\"index\":[",
		s_mmeIndex.fileSize,
		s_mmeIndex.startTime,
		s_mmeIndex.endTime,
		s_mmeIndex.totalFrames,
		mapName,
		s_mmeIndex.fileIndexCount
	);
	for ( int idx = 0; idx < s_mmeIndex.fileIndexCount; idx++ ) {
		fprintf(
			metaFp,
			"%s[%d,%d,%d]",
			( idx > 0 ) ? "," : "",
			s_mmeIndex.fileIndex[idx].pos,
			s_mmeIndex.fileIndex[idx].time,
			s_mmeIndex.fileIndex[idx].frame
		);
	}
	fprintf( metaFp, "]}\n" );
	fflush( metaFp );
	fclose( metaFp );
	if ( rename( tmpMetaPath, outMetaPath ) != 0 ) {
		remove( tmpMetaPath );
		return 4;
	}
	return 0;
}
