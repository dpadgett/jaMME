/*
 *      tr_framebuffer.c
 *      
 *      Copyright 2007 Gord Allott <gordallott@gmail.com>
 *      
 *      This program is free software; you can redistribute it and/or modify
 *      it under the terms of the GNU General Public License as published by
 *      the Free Software Foundation; either version 2 of the License, or
 *      (at your option) any later version.
 *      
 *      This program is distributed in the hope that it will be useful,
 *      but WITHOUT ANY WARRANTY; without even the implied warranty of
 *      MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 *      GNU General Public License for more details.
 *      
 *      You should have received a copy of the GNU General Public License
 *      along with this program; if not, write to the Free Software
 *      Foundation, Inc., 51 Franklin Street, Fifth Floor, Boston,
 *      MA 02110-1301, USA.
*/
// tr_framebuffer.c: framebuffer object rendering path code
// Okay i am going to try and document what I doing here, appologies to anyone 
// that already understands this. basically the idea is that normally everything
// opengl renders will be rendered into client memory, that is the space the 
// graphics card reserves for anything thats going to be sent to the monitor.
// Using this method we instead redirect all the rendering to a seperate bit of 
// memory called a frame buffer. 
// we can then bind this framebuffer to a texture and render that texture to the
// client memory again so that the image will be sent to the monitor. this 
// redirection allows for some neat effects to be applied.

// Some ideas for what to use this path for:
//		- Bloom	-done
//		- Rotoscope cartoon effects (edge detect + colour mapping)
//		- Fake anti-aliasing. (edge detect and blur positive matches)
//		- Motion blur
//			- generate a speed vector based on how the camera has moved since 
//			  the last frame and use that to compute per pixel blur vectors 
//		- These would require mods to use some sort of framebuffer qvm api
//			- special effects for certain powerups 
//			- Image Blur when the player is hit
//			- Depth of field blur

//Sjoerd
//Butchered this up a bit for MME needs and only really has been tested for my ATI videocard

//#pragma once

#include "tr_local.h"
#ifdef _WIN32
#include "qgl.h"
#endif
#ifdef __EMSCRIPTEN__
#include <emscripten.h>
#endif

cvar_t *r_fbo;
cvar_t *r_fboMultiSample;
cvar_t *r_fboBlur;
cvar_t *r_fboWidth;
cvar_t *r_fboHeight;

#define GL_DEPTH_STENCIL_EXT 0x84F9
#define GL_UNSIGNED_INT_24_8_EXT 0x84FA
#define GL_DEPTH24_STENCIL8_EXT 0x88F0

#define RGBA32F_ARB                      0x8814
#define RGBA16F_ARB                      0x881A
#define GL_HALF_FLOAT_OES_VAL            0x8D61
#define GL_DEPTH_STENCIL_ATTACHMENT_VAL  0x821A
#define GL_DEPTH_COMPONENT16_VAL         0x81A5
#ifndef GL_FRAGMENT_SHADER_ARB
#define GL_FRAGMENT_SHADER_ARB           0x8B30
#endif
#ifndef GL_VERTEX_SHADER_ARB
#define GL_VERTEX_SHADER_ARB             0x8B31
#endif
#ifndef GL_OBJECT_COMPILE_STATUS_ARB
#define GL_OBJECT_COMPILE_STATUS_ARB     0x8B81
#endif
#ifndef GL_OBJECT_LINK_STATUS_ARB
#define GL_OBJECT_LINK_STATUS_ARB        0x8B82
#endif

#ifndef GL_DEPTH_STENCIL_EXT
#define GL_DEPTH_STENCIL_EXT GL_DEPTH_STENCIL_NV
#endif

#ifndef GL_UNSIGNED_INT_24_8_EXT
#define GL_UNSIGNED_INT_24_8_EXT GL_UNSIGNED_INT_24_8_NV
#endif

static struct {
	frameBufferData_t *multiSample;
	frameBufferData_t *main;
	frameBufferData_t *blur;
	frameBufferData_t *dof;
	int screenWidth, screenHeight;
} fbo;

//two functions to bind and unbind the main framebuffer, generally just to be
//called externaly

void R_SetGL2DSize (int width, int height) {

	// set 2D virtual screen size
	qglViewport( 0, 0, width, height );
	qglScissor( 0, 0, width, height );
	qglMatrixMode(GL_PROJECTION);
    qglLoadIdentity ();
	qglOrtho (0, width, height, 0, 0, 1);
	qglMatrixMode(GL_MODELVIEW);
    qglLoadIdentity ();
}

void R_DrawQuad( GLuint tex, int width, int height) {
#ifdef HAVE_GLES
	//TODO
#else
	if ( qglActiveTextureARB ) {
		GL_SelectTexture( 1 );
		qglDisable( GL_TEXTURE_2D );
		GL_SelectTexture( 0 );
	}
	qglEnable(GL_TEXTURE_2D);
	GL_TexEnv( GL_MODULATE );
	if ( glState.currenttextures[0] != tex ) {
		GL_SelectTexture( 0 );
		qglBindTexture(GL_TEXTURE_2D, tex);
		glState.currenttextures[0] = tex; 
	};

	qglBegin(GL_QUADS);
	  qglTexCoord2f(0.0, 1.0); qglVertex2f(0.0  , 0.0   );	
	  qglTexCoord2f(1.0, 1.0); qglVertex2f(width, 0.0   );	
	  qglTexCoord2f(1.0, 0.0); qglVertex2f(width, height);	
	  qglTexCoord2f(0.0, 0.0); qglVertex2f(0.0  , height);	
	qglEnd();	
#endif
}

static int CreateTextureBuffer( int width, int height, GLenum internalFormat, GLenum format, GLenum type ) {
	int ret = 0;
	int error = qglGetError();
	qglGenTextures( 1, (GLuint *)&ret );
	qglBindTexture(	GL_TEXTURE_2D, ret );
	qglTexParameteri( GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_NEAREST );
	qglTexParameteri( GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_NEAREST );

	qglTexParameteri( GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, GL_CLAMP_TO_EDGE );
	qglTexParameteri( GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, GL_CLAMP_TO_EDGE );
	qglTexImage2D(	GL_TEXTURE_2D, 0, internalFormat, width, height, 0, format, type, 0 );
	error = qglGetError();
	return ret;
}

static int CreateRenderBuffer( int samples, int width, int height, GLenum bindType) {
	int ret = 0;
#ifdef HAVE_GLES
	//TODO
#else
	qglGenRenderbuffers( 1, (GLuint *)&ret );
	qglBindRenderbuffer( GL_RENDERBUFFER_EXT, ret );
	if ( samples ) {
		qglRenderbufferStorageMultisampleEXT( GL_RENDERBUFFER_EXT, samples, bindType, width, height );
	} else {
		qglRenderbufferStorage(	GL_RENDERBUFFER_EXT, bindType, width, height );
	}
#endif
	return ret;
}

//------------------------------
// better framebuffer creation
//------------------------------
// for this we do a more opengl way of figuring out what level of framebuffer
// objects are supported. we try each mode from 'best' to 'worst' until we 
// get a mode that works.


void R_FrameBufferDelete( frameBufferData_t* buffer ) {  
#ifdef HAVE_GLES
	//TODO
#else
	if ( !buffer )
		return;
	qglDeleteFramebuffers(1, &(buffer->fbo));
	if ( buffer->color ) {
		if ( buffer->flags & FB_MULTISAMPLE ) {
			qglDeleteRenderbuffers(1, &(buffer->color) );
		} else {
			qglDeleteTextures( 1, &(buffer->color) );
		}
	}
	if ( buffer->depth ) {
		qglDeleteRenderbuffers(1, &(buffer->depth) );
	}
	if ( buffer->stencil ) {
		qglDeleteRenderbuffers(1, &(buffer->stencil) );
	}
	if ( buffer->packed ) {
#ifdef __EMSCRIPTEN__
		qglDeleteRenderbuffers(1, &(buffer->packed) );
#else
		if ( buffer->flags & FB_MULTISAMPLE ) {
			qglDeleteRenderbuffers(1, &(buffer->packed) );
		} else {
			qglDeleteTextures( 1, &(buffer->packed) );
		}
#endif
	}
	free( buffer );
#endif
}

frameBufferData_t* R_FrameBufferCreate( int width, int height, int flags ) {
#ifdef HAVE_GLES
	//TODO
	return NULL;
#else
	frameBufferData_t *buffer;
	GLuint status;
	int samples = 0;

	buffer = (frameBufferData_t *)malloc( sizeof( *buffer ) );
	memset( buffer, 0, sizeof( *buffer ) );
	buffer->flags = flags;
	buffer->width = width;
	buffer->height = height;

	//gen the frame buffer
	qglGenFramebuffers(1, &(buffer->fbo) );
	qglBindFramebuffer(GL_FRAMEBUFFER_EXT, buffer->fbo);

#ifdef __EMSCRIPTEN__
	(void)samples;
	if ( flags & FB_PACKED ) {
		buffer->packed = CreateRenderBuffer( 0, width, height, GL_DEPTH_STENCIL_EXT );
		qglFramebufferRenderbuffer( GL_FRAMEBUFFER_EXT, GL_DEPTH_STENCIL_ATTACHMENT_VAL, GL_RENDERBUFFER_EXT, buffer->packed );
	} else if ( flags & FB_DEPTH ) {
		buffer->depth = CreateRenderBuffer( 0, width, height, GL_DEPTH_COMPONENT16_VAL );
		qglFramebufferRenderbuffer( GL_FRAMEBUFFER_EXT, GL_DEPTH_ATTACHMENT_EXT, GL_RENDERBUFFER_EXT, buffer->depth );
	}

	status = GL_FRAMEBUFFER_UNSUPPORTED_EXT;
	if ( flags & FB_FLOAT32 ) {
		buffer->color = CreateTextureBuffer( width, height, GL_RGBA, GL_RGBA, GL_FLOAT );
		qglFramebufferTexture2D( GL_FRAMEBUFFER_EXT, GL_COLOR_ATTACHMENT0_EXT, GL_TEXTURE_2D, buffer->color, 0 );
		status = qglCheckFramebufferStatus( GL_FRAMEBUFFER_EXT );
		if ( status != GL_FRAMEBUFFER_COMPLETE_EXT ) {
			qglDeleteTextures( 1, &(buffer->color) );
			buffer->color = 0;
		}
	}
	if ( !buffer->color && (flags & (FB_FLOAT16 | FB_FLOAT32)) ) {
		buffer->color = CreateTextureBuffer( width, height, GL_RGBA, GL_RGBA, GL_HALF_FLOAT_OES_VAL );
		qglFramebufferTexture2D( GL_FRAMEBUFFER_EXT, GL_COLOR_ATTACHMENT0_EXT, GL_TEXTURE_2D, buffer->color, 0 );
		status = qglCheckFramebufferStatus( GL_FRAMEBUFFER_EXT );
		if ( status != GL_FRAMEBUFFER_COMPLETE_EXT ) {
			qglDeleteTextures( 1, &(buffer->color) );
			buffer->color = 0;
		}
	}
	if ( !buffer->color ) {
		buffer->color = CreateTextureBuffer( width, height, GL_RGBA, GL_RGBA, GL_UNSIGNED_BYTE );
		qglFramebufferTexture2D( GL_FRAMEBUFFER_EXT, GL_COLOR_ATTACHMENT0_EXT, GL_TEXTURE_2D, buffer->color, 0 );
		status = qglCheckFramebufferStatus( GL_FRAMEBUFFER_EXT );
	}
	if ( status != GL_FRAMEBUFFER_COMPLETE_EXT && buffer->packed ) {
		qglFramebufferRenderbuffer( GL_FRAMEBUFFER_EXT, GL_DEPTH_STENCIL_ATTACHMENT_VAL, GL_RENDERBUFFER_EXT, 0 );
		qglDeleteRenderbuffers( 1, &(buffer->packed) );
		buffer->packed = 0;
		buffer->depth = CreateRenderBuffer( 0, width, height, GL_DEPTH_COMPONENT16_VAL );
		qglFramebufferRenderbuffer( GL_FRAMEBUFFER_EXT, GL_DEPTH_ATTACHMENT_EXT, GL_RENDERBUFFER_EXT, buffer->depth );
		status = qglCheckFramebufferStatus( GL_FRAMEBUFFER_EXT );
	}
#else
	if ( flags & FB_MULTISAMPLE ) {
		samples = r_fboMultiSample->integer;
	}

	if ( flags & FB_PACKED ) {
		if ( samples ) {
			buffer->packed = CreateRenderBuffer( samples, width, height, GL_DEPTH24_STENCIL8_EXT );
			qglFramebufferRenderbuffer(GL_FRAMEBUFFER_EXT, GL_DEPTH_ATTACHMENT_EXT, GL_RENDERBUFFER_EXT, buffer->packed );
			qglFramebufferRenderbuffer(GL_FRAMEBUFFER_EXT, GL_STENCIL_ATTACHMENT_EXT, GL_RENDERBUFFER_EXT, buffer->packed );
		} else {
			// Setup depth_stencil texture (not mipmap)
			buffer->packed = CreateTextureBuffer( width, height, GL_DEPTH24_STENCIL8_EXT, GL_DEPTH_STENCIL_EXT, GL_UNSIGNED_INT_24_8_EXT );
			qglFramebufferTexture2D(GL_FRAMEBUFFER_EXT, GL_DEPTH_ATTACHMENT_EXT, GL_TEXTURE_2D, buffer->packed, 0);
			qglFramebufferTexture2D(GL_FRAMEBUFFER_EXT, GL_STENCIL_ATTACHMENT_EXT, GL_TEXTURE_2D, buffer->packed, 0);
		}
	} else {
		if ( flags & FB_DEPTH ) {
			buffer->depth = CreateRenderBuffer( samples, width, height, GL_DEPTH_COMPONENT );
			qglFramebufferRenderbuffer(	GL_FRAMEBUFFER_EXT, GL_DEPTH_ATTACHMENT_EXT, GL_RENDERBUFFER_EXT, buffer->depth );
		}
		if ( flags & FB_STENCIL ) {
			buffer->stencil = CreateRenderBuffer( samples, width, height, GL_STENCIL_INDEX8_EXT );
			qglFramebufferRenderbuffer(	GL_FRAMEBUFFER_EXT, GL_STENCIL_ATTACHMENT_EXT, GL_RENDERBUFFER_EXT, buffer->stencil );
		}
	}
	/* Attach the color buffer */
	
	if ( samples ) {
		buffer->color = CreateRenderBuffer( samples, width, height, GL_RGBA );
		qglFramebufferRenderbuffer(	GL_FRAMEBUFFER_EXT, GL_COLOR_ATTACHMENT0_EXT, GL_RENDERBUFFER_EXT, buffer->color );
	} else if ( flags & FB_FLOAT16 ) {
		buffer->color = CreateTextureBuffer( width, height, RGBA16F_ARB, GL_RGBA, GL_FLOAT );
		qglFramebufferTexture2D(GL_FRAMEBUFFER_EXT, GL_COLOR_ATTACHMENT0_EXT, GL_TEXTURE_2D, buffer->color, 0);
	} else if ( flags & FB_FLOAT32 ) {
		buffer->color = CreateTextureBuffer( width, height, RGBA32F_ARB, GL_RGBA, GL_FLOAT );
		qglFramebufferTexture2D(GL_FRAMEBUFFER_EXT, GL_COLOR_ATTACHMENT0_EXT, GL_TEXTURE_2D, buffer->color, 0);
	} else {
		buffer->color = CreateTextureBuffer( width, height, GL_RGBA, GL_RGBA, GL_UNSIGNED_BYTE );
		qglFramebufferTexture2D(GL_FRAMEBUFFER_EXT, GL_COLOR_ATTACHMENT0_EXT, GL_TEXTURE_2D, buffer->color, 0);
	}
		
	status = qglCheckFramebufferStatus(GL_FRAMEBUFFER_EXT);
#endif

	if ( status != GL_FRAMEBUFFER_COMPLETE_EXT ) {
		switch(status) {
        case GL_FRAMEBUFFER_COMPLETE_EXT:
            break;
        case GL_FRAMEBUFFER_UNSUPPORTED_EXT:
            ri.Printf( PRINT_ALL, "Unsupported framebuffer format\n" );
            break;
        case GL_FRAMEBUFFER_INCOMPLETE_MISSING_ATTACHMENT_EXT:
            ri.Printf( PRINT_ALL, "Framebuffer incomplete, missing attachment\n" );
            break;
        case GL_FRAMEBUFFER_INCOMPLETE_ATTACHMENT_EXT:
            ri.Printf( PRINT_ALL, "Framebuffer incomplete, duplicate attachment\n" );
            break;
        case GL_FRAMEBUFFER_INCOMPLETE_DIMENSIONS_EXT:
            ri.Printf( PRINT_ALL, "Framebuffer incomplete, attached images must have same dimensions\n" );
            break;
        case GL_FRAMEBUFFER_INCOMPLETE_FORMATS_EXT:
            ri.Printf( PRINT_ALL, "Framebuffer incomplete, attached images must have same format\n" );
            break;
        case GL_FRAMEBUFFER_INCOMPLETE_DRAW_BUFFER_EXT:
            ri.Printf( PRINT_ALL, "Framebuffer incomplete, missing draw buffer\n" );
            break;
        case GL_FRAMEBUFFER_INCOMPLETE_READ_BUFFER_EXT:
            ri.Printf( PRINT_ALL, "Framebuffer incomplete, missing read buffer\n" );
            break;
	    }
		R_FrameBufferDelete( buffer );
		return 0;
	}		
	return buffer;
#endif
}

void R_FrameBuffer_Init( void ) {
#ifdef HAVE_GLES
	//TODO
#else
	int flags, width, height;

	memset( &fbo, 0, sizeof( fbo ) );
#ifdef __EMSCRIPTEN__
	r_fbo = ri.Cvar_Get( "r_fbo", "0", CVAR_ARCHIVE );
	r_fboBlur = ri.Cvar_Get( "r_fboBlur", "0", CVAR_ARCHIVE );
	r_fboWidth = ri.Cvar_Get( "r_fboWidth", "0", CVAR_ARCHIVE );
	r_fboHeight = ri.Cvar_Get( "r_fboHeight", "0", CVAR_ARCHIVE );
	r_fboMultiSample = ri.Cvar_Get( "r_fboMultiSample", "0", CVAR_ARCHIVE );
#else
	r_fbo = ri.Cvar_Get( "r_fbo", "0", CVAR_ARCHIVE | CVAR_LATCH);	
	r_fboBlur = ri.Cvar_Get( "r_fboBlur", "0", CVAR_ARCHIVE | CVAR_LATCH);	
	r_fboWidth = ri.Cvar_Get( "r_fboWidth", "0", CVAR_ARCHIVE | CVAR_LATCH);	
	r_fboHeight = ri.Cvar_Get( "r_fboHeight", "0", CVAR_ARCHIVE | CVAR_LATCH);	
	r_fboMultiSample = ri.Cvar_Get( "r_fboMultiSample", "0", CVAR_ARCHIVE | CVAR_LATCH);	
#endif

	// make sure all the commands added here are also		

	if (!glMMEConfig.framebufferObject || !glMMEConfig.shaderSupport) {
		ri.Printf( PRINT_WARNING, "WARNING: Framebuffer rendering path disabled\n");
		return;
	}

	if ( !r_fbo->integer ) {
		return;
	}

	ri.Printf( PRINT_ALL, "----- Enabling FrameBuffer Path -----\n" );

	//set our main screen flags									
	flags = 0;
	if ( (glConfig.stencilBits > 0) ) {
		flags |= FB_PACKED;
	} else {
		flags |= FB_DEPTH;
	}
	
	fbo.screenWidth = glMMEConfig.glWidth;
	fbo.screenHeight = glMMEConfig.glHeight;

	width = r_fboWidth->integer;
	height = r_fboHeight->integer;
	//Illegal width/height use original opengl one
	if ( width <= 0 || height <= 0 ) {
		width = fbo.screenWidth;
		height = fbo.screenHeight;
	}

	//create our main frame buffer
	fbo.main = R_FrameBufferCreate( width, height, flags );

	if (!fbo.main) {
		// if the main fbuffer failed then we should disable framebuffer 
		// rendering
		glMMEConfig.framebufferObject = qfalse;
		ri.Printf( PRINT_WARNING, "WARNING: Framebuffer creation failed\n");
		ri.Printf( PRINT_WARNING, "WARNING: Framebuffer rendering path disabled\n");
		//Reinit back to window rendering in case status fails
		qglBindFramebuffer(GL_FRAMEBUFFER_EXT, 0 );
		return;
	}

	if ( r_fboMultiSample->integer ) {
		flags |= FB_MULTISAMPLE;
		flags &= ~FB_PACKED;
		flags |= FB_DEPTH;
		fbo.multiSample = R_FrameBufferCreate( width, height, flags );
	}

	glConfig.vidWidth = width;
	glConfig.vidHeight = height;

	if ( r_fboBlur->integer > 1 ) {
		flags = FB_FLOAT32;
		fbo.blur = R_FrameBufferCreate( width, height, flags );
	} else if ( r_fboBlur->integer  ) {
		flags = FB_FLOAT16;
		fbo.blur = R_FrameBufferCreate( width, height, flags );
	}

	qglBindFramebuffer(GL_FRAMEBUFFER_EXT, 0 );
#endif
}

static qboolean usedFloat;
static qboolean fboSkipEndFrame = qfalse;
static qboolean fboPresentedThisFrame = qfalse;

#ifdef __EMSCRIPTEN__
EM_JS(int, wasm_gl_software_blur_accum, (int blurTexId, int mainTexId, float scale, int frame, int total), {
	try {
		if (typeof GLctx !== 'undefined' && GLctx && typeof GLctx.__jkSoftwareBlurAccum === 'function') {
			var blurTex = (typeof GL !== 'undefined' && GL.textures) ? GL.textures[blurTexId] : null;
			var mainTex = (typeof GL !== 'undefined' && GL.textures) ? GL.textures[mainTexId] : null;
			return GLctx.__jkSoftwareBlurAccum(blurTex, mainTex, scale, frame, total) ? 1 : 0;
		}
	} catch (e) {}
	return 0;
});

EM_JS(int, wasm_gl_draw_gamma_quad, (int srcTexId, float invGamma, int screenW, int screenH), {
	try {
		if (typeof GLctx === 'undefined' || !GLctx) return 0;
		var texObj = (typeof GL !== 'undefined' && GL.textures) ? GL.textures[srcTexId] : null;
		if (!texObj) return 0;

		if (typeof GLctx.__jkSoftwareGammaResolve === 'function') {
			return GLctx.__jkSoftwareGammaResolve(texObj, invGamma, screenW, screenH) ? 1 : 0;
		}

		var gl = GLctx;
		if (!gl.__jkGammaBlit) {
			var vs = gl.createShader(gl.VERTEX_SHADER);
			gl.shaderSource(vs,
				'attribute vec2 a_pos;\n' +
				'attribute vec2 a_uv;\n' +
				'varying vec2 v_uv;\n' +
				'void main() {\n' +
				'  v_uv = a_uv;\n' +
				'  gl_Position = vec4(a_pos, 0.0, 1.0);\n' +
				'}\n'
			);
			gl.compileShader(vs);
			var fs = gl.createShader(gl.FRAGMENT_SHADER);
			gl.shaderSource(fs,
				'precision mediump float;\n' +
				'uniform sampler2D u_tex;\n' +
				'uniform float u_invGamma;\n' +
				'varying vec2 v_uv;\n' +
				'void main() {\n' +
				'  vec4 c = texture2D(u_tex, v_uv);\n' +
				'  gl_FragColor = vec4(pow(max(c.rgb, vec3(0.0)), vec3(u_invGamma)), 1.0);\n' +
				'}\n'
			);
			gl.compileShader(fs);
			var prog = gl.createProgram();
			gl.bindAttribLocation(prog, 0, 'a_pos');
			gl.bindAttribLocation(prog, 1, 'a_uv');
			gl.attachShader(prog, vs);
			gl.attachShader(prog, fs);
			gl.linkProgram(prog);
			if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
				console.warn('Gamma blit link failed:', gl.getProgramInfoLog(prog));
				gl.__jkGammaBlit = { failed: true };
				return 0;
			}
			var vbo = gl.createBuffer();
			var prevBufInit = gl.getParameter(gl.ARRAY_BUFFER_BINDING);
			gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
			gl.bufferData(
				gl.ARRAY_BUFFER,
				new Float32Array([
					-1, -1, 0, 0,
					 1, -1, 1, 0,
					-1,  1, 0, 1,
					 1,  1, 1, 1
				]),
				gl.STATIC_DRAW
			);
			gl.bindBuffer(gl.ARRAY_BUFFER, prevBufInit);
			gl.__jkGammaBlit = {
				prog: prog,
				vbo: vbo,
				uTex: gl.getUniformLocation(prog, 'u_tex'),
				uInvGamma: gl.getUniformLocation(prog, 'u_invGamma')
			};
		}
		if (gl.__jkGammaBlit.failed) return 0;

		var gb = gl.__jkGammaBlit;
		var prevProg = gl.currentProgram || null;
		var prevBuf = gl.getParameter(gl.ARRAY_BUFFER_BINDING);

		gl.viewport(0, 0, screenW, screenH);
		gl.disable(gl.DEPTH_TEST);
		gl.disable(gl.BLEND);
		gl.disable(gl.CULL_FACE);
		gl.disable(gl.SCISSOR_TEST);

		gl.useProgram(gb.prog);
		gl.activeTexture(gl.TEXTURE0);
		gl.bindTexture(gl.TEXTURE_2D, texObj);
		gl.uniform1i(gb.uTex, 0);
		gl.uniform1f(gb.uInvGamma, invGamma);

		gl.bindBuffer(gl.ARRAY_BUFFER, gb.vbo);
		gl.enableVertexAttribArray(0);
		gl.enableVertexAttribArray(1);
		gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 16, 0);
		gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 16, 8);
		gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

		gl.disableVertexAttribArray(1);
		gl.bindBuffer(gl.ARRAY_BUFFER, prevBuf);
		gl.useProgram(prevProg);
		if (typeof GLImmediate !== 'undefined' && GLImmediate) {
			GLImmediate.currentRenderer = null;
			GLImmediate.modifiedClientAttributes = true;
		}
		return 1;
	} catch (e) {
		console.warn('wasm_gl_draw_gamma_quad error:', e);
		return 0;
	}
});

static void R_FrameBuffer_SyncWasm( void ) {
	if ( !glMMEConfig.framebufferObject || !glMMEConfig.shaderSupport || !r_fbo || !r_fbo->integer ) {
		if ( fbo.main || fbo.blur ) {
			R_FrameBufferDelete( fbo.main );
			R_FrameBufferDelete( fbo.blur );
			fbo.main = NULL;
			fbo.blur = NULL;
			qglBindFramebuffer( GL_FRAMEBUFFER_EXT, 0 );
		}
		return;
	}

	int screenW = glMMEConfig.glWidth > 0 ? glMMEConfig.glWidth : glConfig.vidWidth;
	int screenH = glMMEConfig.glHeight > 0 ? glMMEConfig.glHeight : glConfig.vidHeight;
	if ( screenW <= 0 || screenH <= 0 )
		return;
	fbo.screenWidth = screenW;
	fbo.screenHeight = screenH;

	int width = (r_fboWidth && r_fboWidth->integer > 0) ? r_fboWidth->integer : screenW;
	int height = (r_fboHeight && r_fboHeight->integer > 0) ? r_fboHeight->integer : screenH;

	if ( !fbo.main || fbo.main->width != width || fbo.main->height != height ) {
		R_FrameBufferDelete( fbo.main );
		R_FrameBufferDelete( fbo.blur );
		fbo.main = NULL;
		fbo.blur = NULL;
		int mainFlags = (glConfig.stencilBits > 0) ? FB_PACKED : FB_DEPTH;
		fbo.main = R_FrameBufferCreate( width, height, mainFlags );
		if ( !fbo.main ) {
			qglBindFramebuffer( GL_FRAMEBUFFER_EXT, 0 );
			return;
		}
		glConfig.vidWidth = width;
		glConfig.vidHeight = height;
	}

	if ( r_fboBlur && r_fboBlur->integer > 0 ) {
		int blurFlags = (r_fboBlur->integer > 1) ? FB_FLOAT32 : FB_FLOAT16;
		if ( !fbo.blur || fbo.blur->width != width || fbo.blur->height != height || fbo.blur->flags != blurFlags ) {
			R_FrameBufferDelete( fbo.blur );
			fbo.blur = R_FrameBufferCreate( width, height, blurFlags );
		}
	} else if ( fbo.blur ) {
		R_FrameBufferDelete( fbo.blur );
		fbo.blur = NULL;
	}
}
#endif

/* Startframe checks if the framebuffer is still active or was just activated */
void R_FrameBuffer_StartFrame( void ) {
#ifdef HAVE_GLES
	//TODO
#else
	fboSkipEndFrame = qfalse;
	fboPresentedThisFrame = qfalse;
#ifdef __EMSCRIPTEN__
	R_FrameBuffer_SyncWasm();
#endif
	if ( !fbo.main ) {
		return;
	}
	if ( fbo.multiSample ) {
		//Bind the framebuffer at the beginning to be drawn in
		qglBindFramebuffer( GL_FRAMEBUFFER_EXT, fbo.multiSample->fbo );
	} else {
		qglBindFramebuffer( GL_FRAMEBUFFER_EXT, fbo.main->fbo );
	}
#ifndef __EMSCRIPTEN__
	qglDrawBuffer( GL_COLOR_ATTACHMENT0_EXT );
#endif
	usedFloat = qfalse;
#endif
}

qboolean R_FrameBuffer_Blur( float scale, int frame, int total ) {
#ifdef HAVE_GLES
	//TODO
	return qfalse;
#else
	float c;
	if ( !fbo.blur )
		return qfalse;
#ifdef __EMSCRIPTEN__
	if ( wasm_gl_software_blur_accum( (int)fbo.blur->color, (int)fbo.main->color, scale, frame, total ) ) {
		usedFloat = qtrue;
		fboSkipEndFrame = (frame == total - 1) ? qfalse : qtrue;
		return qtrue;
	}
#endif
	qglBindFramebuffer( GL_FRAMEBUFFER_EXT, fbo.blur->fbo );
#ifndef __EMSCRIPTEN__
	qglDrawBuffer( GL_COLOR_ATTACHMENT0_EXT );
#endif
	//The color used to blur add this frame
	c = scale;
	qglColor4f( c, c, c, 1 );
	if ( frame == 0 ) {
		GL_State( GLS_SRCBLEND_ONE | GLS_DSTBLEND_ZERO | GLS_DEPTHTEST_DISABLE );
	} else {
		GL_State( GLS_SRCBLEND_ONE | GLS_DSTBLEND_ONE | GLS_DEPTHTEST_DISABLE );
	}
	R_SetGL2DSize( glConfig.vidWidth, glConfig.vidHeight );
	R_DrawQuad(	fbo.main->color, glConfig.vidWidth, glConfig.vidHeight );
	//Reset fbo
	qglBindFramebuffer( GL_FRAMEBUFFER_EXT, fbo.main->fbo );
#ifndef __EMSCRIPTEN__
	qglDrawBuffer( GL_COLOR_ATTACHMENT0_EXT );
#endif
	usedFloat = qtrue;
	if ( frame == total - 1 ) {
		qglColor4f( 1, 1, 1, 1 );
		GL_State( GLS_DEPTHTEST_DISABLE );
		R_DrawQuad(	fbo.blur->color, glConfig.vidWidth, glConfig.vidHeight );
		fboSkipEndFrame = qfalse;
	} else {
		fboSkipEndFrame = qtrue;
	}
	return qtrue;
#endif
}

void R_FrameBuffer_EndFrame( void ) {
#ifdef HAVE_GLES
	//TODO
#else
	if ( !fbo.main || fboSkipEndFrame || fboPresentedThisFrame ) {
		return;
	}
	if ( fbo.multiSample ) {
		const frameBufferData_t* src = fbo.multiSample;
		const frameBufferData_t* dst = fbo.main;

		qglBindFramebuffer( GL_READ_FRAMEBUFFER_EXT, src->fbo );
		qglBindFramebuffer( GL_DRAW_FRAMEBUFFER_EXT, dst->fbo );
		qglBlitFramebufferEXT(0, 0, src->width, src->height, 0, 0, dst->width, dst->height, GL_COLOR_BUFFER_BIT | GL_DEPTH_BUFFER_BIT | GL_STENCIL_BUFFER_BIT, GL_NEAREST);
	}
	GL_State( GLS_DEPTHTEST_DISABLE );
	qglColor4f( 1, 1, 1, 1 );
	qglBindFramebuffer(GL_FRAMEBUFFER_EXT, 0);
	R_SetGL2DSize( fbo.screenWidth, fbo.screenHeight );
	GLuint srcTex = usedFloat ? fbo.blur->color : fbo.main->color;
#ifdef __EMSCRIPTEN__
	float gammaVal = (r_gamma && r_gamma->value > 0.05f) ? r_gamma->value : 1.0f;
	float invGamma = 1.0f / gammaVal;
	if ( !wasm_gl_draw_gamma_quad( (int)srcTex, invGamma, fbo.screenWidth, fbo.screenHeight ) ) {
		R_DrawQuad( srcTex, fbo.screenWidth, fbo.screenHeight );
	}
#else
	R_DrawQuad( srcTex, fbo.screenWidth, fbo.screenHeight );
#endif
	usedFloat = qfalse;
	fboPresentedThisFrame = qtrue;
#endif
}

void R_FrameBuffer_Shutdown( void ) {
	R_FrameBufferDelete( fbo.main );
	R_FrameBufferDelete( fbo.blur );
	R_FrameBufferDelete( fbo.multiSample );
	memset( &fbo, 0, sizeof( fbo ) );
}
