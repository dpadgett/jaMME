// Copyright (C) 2009 Sjoerd van der Berg ( harekiet @ gmail.com )

#include "tr_mme.h"

static void aviWrite16( void *pos, unsigned short val) {
	unsigned char *data = (unsigned char *)pos;
	data[0] = (val >> 0) & 0xff;
	data[1] = (val >> 8) & 0xff;
}

static void aviWrite32( void *pos, unsigned int val) {
	unsigned char *data = (unsigned char *)pos;
	data[0] = (val >> 0) & 0xff;
	data[1] = (val >> 8) & 0xff;
	data[2] = (val >> 16) & 0xff;
	data[3] = (val >> 24) & 0xff;
}

void aviClose( mmeAviFile_t *aviFile ) {
	char avi_header[AVI_HEADER_SIZE];
	char index[16];
	int main_list, nmain, njunk;
	int header_pos=0;
	int framePos, i;
	qboolean storeMJPEG = (qboolean)aviFile->format;

//	if (!aviFile->file)
//		return;
	if (!aviFile->f)
		return;
	Com_Memset( avi_header, 0, sizeof( avi_header ));

#define AVIOUT4(_S_) memcpy(&avi_header[header_pos],_S_,4);header_pos+=4;
#define AVIOUTw(_S_) aviWrite16(&avi_header[header_pos], _S_);header_pos+=2;
#define AVIOUTd(_S_) aviWrite32(&avi_header[header_pos], _S_);header_pos+=4;
	/* Try and write an avi header */
	AVIOUT4("RIFF");                    // Riff header 
	AVIOUTd(AVI_HEADER_SIZE + aviFile->written - 8 + aviFile->frames * 16);
	AVIOUT4("AVI ");
	AVIOUT4("LIST");                    // List header
	main_list = header_pos;
	AVIOUTd(0);				            // TODO size of list
	AVIOUT4("hdrl");
	AVIOUT4("avih");
	AVIOUTd(56);                         /* # of bytes to follow */
	AVIOUTd(1000000 / aviFile->fps );    /* Microseconds per frame */
	AVIOUTd(0);
	AVIOUTd(0);                         /* PaddingGranularity (whatever that might be) */
	AVIOUTd(0x110);                     /* Flags,0x10 has index, 0x100 interleaved */
	AVIOUTd( aviFile->frames );		    /* TotalFrames */
	AVIOUTd(0);                         /* InitialFrames */
	AVIOUTd(1);                         /* Stream count */
	AVIOUTd(0);                         /* SuggestedBufferSize */
	AVIOUTd(aviFile->width);	        /* Width */
	AVIOUTd(aviFile->height);		    /* Height */
	AVIOUTd(0);                         /* TimeScale:  Unit used to measure time */
	AVIOUTd(0);                         /* DataRate:   Data rate of playback     */
	AVIOUTd(0);                         /* StartTime:  Starting time of AVI data */
	AVIOUTd(0);                         /* DataLength: Size of AVI data chunk    */

	/* Video stream list */
	AVIOUT4("LIST");
	AVIOUTd(4 + 8 + 56 + 8 + 40);       /* Size of the list */
	AVIOUT4("strl");
	/* video stream header */
    AVIOUT4("strh");
	AVIOUTd(56);                        /* # of bytes to follow */
	AVIOUT4("vids");                    /* Type */
	if ( aviFile->format == 1) { /* Handler */
		AVIOUT4("MJPG");      		    
	} else {
		AVIOUTd(0);
	}
	AVIOUTd(0);                         /* Flags */
	AVIOUTd(0);                         /* Reserved, MS says: wPriority, wLanguage */
	AVIOUTd(0);                         /* InitialFrames */
	AVIOUTd(1000000);                   /* Scale */
	AVIOUTd(1000000 * aviFile->fps);    /* Rate: Rate/Scale == samples/second */
	AVIOUTd(0);                         /* Start */
	AVIOUTd(aviFile->frames);           /* Length */
	AVIOUTd(0);                         /* SuggestedBufferSize */
	AVIOUTd(~0);                        /* Quality */
	AVIOUTd(0);                         /* SampleSize */
	AVIOUTd(0);                         /* Frame */
	AVIOUTd(0);                         /* Frame */
	/* The video stream format */
	AVIOUT4("strf");
	AVIOUTd(40);                        /* # of bytes to follow */
	AVIOUTd(40);                        /* Size */
	AVIOUTd(aviFile->width);            /* Width */
	AVIOUTd(aviFile->height);           /* Height */
	AVIOUTw(1);							/* Planes */
	if (!storeMJPEG && aviFile->type == mmeShotTypeGray ) {
		AVIOUTw(8);						/* BitCount */
	} else {
		AVIOUTw(24);					/* BitCount */
	}
	if ( storeMJPEG ) { /* Compression */
		AVIOUT4("MJPG");      		    
	} else {
		AVIOUTd(0);
	}
	AVIOUTd(aviFile->width * aviFile->height*3);  /* SizeImage (in bytes?) */
	AVIOUTd(0);                  /* XPelsPerMeter */
	AVIOUTd(0);                  /* YPelsPerMeter */
	if ( !storeMJPEG && aviFile->type == mmeShotTypeGray ) {
		AVIOUTd(255);			 /* colorUsed */
	} else {
		AVIOUTd(0);				 /* colorUsed */
	}
	AVIOUTd(0);                  /* ClrImportant: Number of colors important */
	if ( !storeMJPEG && aviFile->type == mmeShotTypeGray ) {
		for(i = 0;i<255;i++) {
			avi_header[header_pos++] = i;
			avi_header[header_pos++] = i;
			avi_header[header_pos++] = i;
			avi_header[header_pos++] = 0;
		}
	}
	nmain = header_pos - main_list - 4;
	/* Finish stream list, i.e. put number of bytes in the list to proper pos */
	njunk = AVI_HEADER_SIZE - 8 - 12 - header_pos;
	AVIOUT4("JUNK");
	AVIOUTd(njunk);
	if ( header_pos > AVI_HEADER_SIZE) {
		ri.Error( ERR_FATAL, "Avi Header too large\n" );
	}
	/* Fix the size of the main list */
	header_pos = main_list;
	AVIOUTd(nmain);
	header_pos = AVI_HEADER_SIZE - 12;
	AVIOUT4("LIST");
	AVIOUTd(aviFile->written+4); /* Length of list in bytes */
	AVIOUT4("movi");
	/* First add the index table to the end */
//	fwrite( "idx1", 4, 1, aviFile->file );
	ri.FS_Write( "idx1", 4, aviFile->f );
	aviWrite32( index, aviFile->frames * 16 );
//	fwrite( index, 4, 1, aviFile->file );
	ri.FS_Write( index, 4, aviFile->f );
	/* Bring on the load of small writes! */
	index[0] = '0';index[1] = '0';
	index[2] = 'd';index[3] = 'b';
	framePos = 4;		//filepos points to the block size
	for(i = 0;i<aviFile->frames;i++) {
		int size = aviFile->index[i];
		aviWrite32( index+4, 0x10 );
		aviWrite32( index+8, framePos );
		aviWrite32( index+12, size );
		framePos += (size + 9) & ~1;
//		fwrite( index, 1, 16, aviFile->file );
		ri.FS_Write( index, 16, aviFile->f );
	}
//	fseek( aviFile->file, 0, SEEK_SET );
//	ri.FS_Seek(aviFile->f, 0, SEEK_SET);
	ri.FS_Seek(aviFile->f, 0, FS_SEEK_SET);
//	fwrite( &avi_header, 1, AVI_HEADER_SIZE, aviFile->file );
	ri.FS_Write( &avi_header, AVI_HEADER_SIZE, aviFile->f );
//	fclose( aviFile->file );
	ri.FS_FCloseFile(aviFile->f);
	Com_Memset( aviFile, 0, sizeof( *aviFile ));
}

qboolean aviOpen( mmeAviFile_t *aviFile, const char *name, mmeShotType_t type, int width, int height, float fps) {
	char fileName[MAX_OSPATH];
	int i;
	char aviHeader[AVI_HEADER_SIZE];

//	if (aviFile->file) {
	if (aviFile->f) {
		Com_Printf( "wtf openAvi on an open handler" );
		return qfalse;
	}
	/* First see if the file already exist */
	for (i = 0;i < 1000;i++) {
//		Com_sprintf( fileName, sizeof(fileName), "%s.%03d.avi", name, i );
		Com_sprintfOld( fileName, sizeof(fileName), "%s.%03d.avi", name, i );
		if (!ri.FS_FileExists( fileName ))
			break;
	}
	if (i == 1000) {
		Com_Printf( "Max avi segments reached\n");
		return qfalse;
	}

	ri.FS_WriteFile( fileName, aviHeader, AVI_HEADER_SIZE );
//	aviFile->file = ri.FS_DirectOpen( fileName, "w+b" );
	aviFile->f = ri.FS_FDirectOpenFileWrite( fileName, "w+b");//ri.FS_FOpenFileWrite( fileName );
//	if (!aviFile->file) {
	if (!aviFile->f) {
		Com_Printf( "Failed to open %s for avi output\n", fileName );
		return qfalse;
	}
	/* File should have been reset to 0 size */
//	fwrite( &aviHeader, 1, AVI_HEADER_SIZE, aviFile->file );
	ri.FS_Write( aviHeader, AVI_HEADER_SIZE, aviFile->f );
	aviFile->width = width;
	aviFile->height = height;
	aviFile->fps = fps;
	aviFile->frames = 0;
	aviFile->written = 0;
	aviFile->format = mme_aviFormat->integer;
	aviFile->type = type;
	Q_strncpyz( aviFile->name, name, sizeof( aviFile->name ));
	return qtrue;
}

qboolean aviValid( const mmeAviFile_t *aviFile, const char *name, mmeShotType_t type, int width, int height, float fps ) {
//	if (!aviFile->file)
	if (!aviFile->f)
		return qfalse;
	if (aviFile->width != width)
		return qfalse;
	if (aviFile->height != height)
		return qfalse;
	if (aviFile->fps != fps )
		return qfalse;
	if (aviFile->type != type)
		return qfalse;
	if (aviFile->written >= AVI_MAX_SIZE)
		return qfalse;
	if ( mme_aviFormat->integer != aviFile->format)
		return qfalse;
	return qtrue;
}

void mmeAviShot( mmeAviFile_t *aviFile, const char *name, mmeShotType_t type, int width, int height, float fps, byte *inBuf ) {
	byte *outBuf;
	int i, pixels, outSize;
	if (!fps)
		return;
	if (!aviValid( aviFile, name, type, width, height, fps )) {
		aviClose( aviFile );
		if (!aviOpen( aviFile, name, type, width, height, fps ))
			return;
	}
	pixels = width*height;
	outSize = width*height*3 + 2048; //Allocate bit more to be safish?
	outBuf = (byte *)ri.Hunk_AllocateTempMemory( outSize + 8);
	outBuf[0] = '0';outBuf[1] = '0';
	outBuf[2] = 'd';outBuf[3] = 'b';
	if ( aviFile->format == 0 ) {
		switch (type) {
		case mmeShotTypeGray:
			for (i = 0;i<pixels;i++) {
				outBuf[8 + i] = inBuf[i];
			};
			outSize = pixels;
			break;
		case mmeShotTypeRGB:
			for (i = 0;i<pixels;i++) {
				outBuf[8 + i*3 + 0 ] = inBuf[ i*3 + 2];
				outBuf[8 + i*3 + 1 ] = inBuf[ i*3 + 1];
				outBuf[8 + i*3 + 2 ] = inBuf[ i*3 + 0];
			}
			outSize = width * height * 3;
			break;
		} 
	} else if ( aviFile->format == 1 ) {
		outSize = SaveJPG( mme_jpegQuality->integer, width, height, type, inBuf, outBuf + 8, outSize );
	}
	aviWrite32( outBuf + 4, outSize );
	aviFile->index[ aviFile->frames ] = outSize;
	aviFile->frames++;

	outSize = (outSize + 9) & ~1;	//make sure we align on 2 byte boundary, hurray M$
//	fwrite( outBuf, 1, outSize, aviFile->file );
	ri.FS_Write( outBuf, outSize, aviFile->f );
	aviFile->written += outSize;

	ri.Hunk_FreeTempMemory( outBuf );
}