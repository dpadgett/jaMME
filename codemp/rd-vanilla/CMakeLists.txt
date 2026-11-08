cmake_minimum_required(VERSION 3.1)

# Make sure the user is not executing this script directly
if(NOT InjaMME)
	message(FATAL_ERROR "Use the top-level cmake script!")
endif(NOT InjaMME)

set(MPVanillaRendererIncludeDirectories ${MPDir})
set(MPVanillaRendererIncludeDirectories ${MPVanillaRendererIncludeDirectories} "${MPDir}/rd-vanilla")

set(MPVanillaRendererFiles
	"${MPDir}/rd-vanilla/glext.h"
	"${MPDir}/rd-vanilla/qgl.h"
	"${MPDir}/rd-vanilla/G2_API.cpp"
	"${MPDir}/rd-vanilla/G2_bolts.cpp"
	"${MPDir}/rd-vanilla/G2_bones.cpp"
	"${MPDir}/rd-vanilla/G2_local.h"
	"${MPDir}/rd-vanilla/G2_misc.cpp"
	"${MPDir}/rd-vanilla/G2_surfaces.cpp"
	"${MPDir}/rd-vanilla/tr_animation.cpp"
	"${MPDir}/rd-vanilla/tr_arioche.cpp"
	"${MPDir}/rd-vanilla/tr_backend.cpp"
	"${MPDir}/rd-vanilla/tr_bloom.cpp"
	"${MPDir}/rd-vanilla/tr_bsp.cpp"
	"${MPDir}/rd-vanilla/tr_cmds.cpp"
	"${MPDir}/rd-vanilla/tr_curve.cpp"
	"${MPDir}/rd-vanilla/tr_font.cpp"
	"${MPDir}/rd-vanilla/tr_framebuffer.cpp"
	"${MPDir}/rd-vanilla/tr_ghoul2.cpp"
	"${MPDir}/rd-vanilla/tr_image.cpp"
	"${MPDir}/rd-vanilla/tr_init.cpp"
	"${MPDir}/rd-vanilla/tr_landscape.h"
	"${MPDir}/rd-vanilla/tr_light.cpp"
	"${MPDir}/rd-vanilla/tr_main.cpp"
	"${MPDir}/rd-vanilla/tr_marks.cpp"
	"${MPDir}/rd-vanilla/tr_mesh.cpp"
	"${MPDir}/rd-vanilla/tr_mme.h"
	"${MPDir}/rd-vanilla/tr_mme.cpp"
	"${MPDir}/rd-vanilla/tr_mme_avi.cpp"
	"${MPDir}/rd-vanilla/tr_mme_mp4.cpp"
	"${MPDir}/rd-vanilla/tr_mme_common.cpp"
	"${MPDir}/rd-vanilla/tr_mme_sse2.cpp"
	"${MPDir}/rd-vanilla/tr_model.cpp"
	"${MPDir}/rd-vanilla/tr_noise.cpp"
	"${MPDir}/rd-vanilla/tr_quicksprite.cpp"
	"${MPDir}/rd-vanilla/tr_quicksprite.h"
	"${MPDir}/rd-vanilla/tr_scene.cpp"
	"${MPDir}/rd-vanilla/tr_shade.cpp"
	"${MPDir}/rd-vanilla/tr_shade_calc.cpp"
	"${MPDir}/rd-vanilla/tr_shader.cpp"
	"${MPDir}/rd-vanilla/tr_shadows.cpp"
	"${MPDir}/rd-vanilla/tr_sky.cpp"
	"${MPDir}/rd-vanilla/tr_surface.cpp"
	"${MPDir}/rd-vanilla/tr_surfacesprites.cpp"
	"${MPDir}/rd-vanilla/tr_terrain.cpp"
	"${MPDir}/rd-vanilla/tr_world.cpp"
	"${MPDir}/rd-vanilla/tr_WorldEffects.cpp"
	"${MPDir}/rd-vanilla/tr_WorldEffects.h"
	)
if(NOT EMSCRIPTEN)
	set(MPVanillaRendererFiles ${MPVanillaRendererFiles} "${MPDir}/rd-vanilla/tr_subs.cpp")
endif()
source_group("renderer" FILES ${MPVanillaRendererFiles})

if(NOT EMSCRIPTEN)
	set(MPVanillaRendererQcommonFiles
		"${MPDir}/qcommon/GenericParser2.cpp"
		"${MPDir}/qcommon/matcomp.cpp"
		"${MPDir}/qcommon/q_math.cpp"
		"${MPDir}/qcommon/q_shared.cpp")
	source_group("qcommon" FILES ${MPVanillaRendererQcommonFiles})
	set(MPVanillaRendererFiles ${MPVanillaRendererFiles} ${MPVanillaRendererQcommonFiles})

	file(GLOB_RECURSE MPVanillaRendererJpegFiles "${MPDir}/jpeg-8c/*.c" "${MPDir}/jpeg-8c/*.h")
	source_group("jpeg-8c" FILES ${MPVanillaRendererJpegFiles})
	set(MPVanillaRendererFiles ${MPVanillaRendererFiles} ${MPVanillaRendererJpegFiles})
endif()

set(MPVanillaRendererPngFiles
	"${MPDir}/png/rpng.cpp")
source_group("png" FILES ${MPVanillaRendererPngFiles})
set(MPVanillaRendererFiles ${MPVanillaRendererFiles} ${MPVanillaRendererPngFiles})

set(MPVanillaRendererLibPngFiles
	"${MPDir}/libpng/png.c"
	"${MPDir}/libpng/pngerror.c"
	"${MPDir}/libpng/pngget.c"
	"${MPDir}/libpng/pngmem.c"
	"${MPDir}/libpng/pngpread.c"
	"${MPDir}/libpng/pngread.c"
	"${MPDir}/libpng/pngrio.c"
	"${MPDir}/libpng/pngrtran.c"
	"${MPDir}/libpng/pngrutil.c"
	"${MPDir}/libpng/pngset.c"
	"${MPDir}/libpng/pngtrans.c"
	"${MPDir}/libpng/pngwio.c"
	"${MPDir}/libpng/pngwrite.c"
	"${MPDir}/libpng/pngwtran.c"
	"${MPDir}/libpng/pngwutil.c")
source_group("libpng" FILES ${MPVanillaRendererLibPngFiles})
set(MPVanillaRendererFiles ${MPVanillaRendererFiles} ${MPVanillaRendererLibPngFiles})

if(EMSCRIPTEN)
	set(MPVanillaRendererVoAacFiles
		"${MPDir}/vo-aacenc/common/cmnMemory.c"
		"${MPDir}/vo-aacenc/aacenc/basic_op/basicop2.c"
		"${MPDir}/vo-aacenc/aacenc/basic_op/oper_32b.c"
		"${MPDir}/vo-aacenc/aacenc/src/aacenc.c"
		"${MPDir}/vo-aacenc/aacenc/src/aacenc_core.c"
		"${MPDir}/vo-aacenc/aacenc/src/aac_rom.c"
		"${MPDir}/vo-aacenc/aacenc/src/adj_thr.c"
		"${MPDir}/vo-aacenc/aacenc/src/band_nrg.c"
		"${MPDir}/vo-aacenc/aacenc/src/bitbuffer.c"
		"${MPDir}/vo-aacenc/aacenc/src/bit_cnt.c"
		"${MPDir}/vo-aacenc/aacenc/src/bitenc.c"
		"${MPDir}/vo-aacenc/aacenc/src/block_switch.c"
		"${MPDir}/vo-aacenc/aacenc/src/channel_map.c"
		"${MPDir}/vo-aacenc/aacenc/src/dyn_bits.c"
		"${MPDir}/vo-aacenc/aacenc/src/grp_data.c"
		"${MPDir}/vo-aacenc/aacenc/src/interface.c"
		"${MPDir}/vo-aacenc/aacenc/src/line_pe.c"
		"${MPDir}/vo-aacenc/aacenc/src/memalign.c"
		"${MPDir}/vo-aacenc/aacenc/src/ms_stereo.c"
		"${MPDir}/vo-aacenc/aacenc/src/pre_echo_control.c"
		"${MPDir}/vo-aacenc/aacenc/src/psy_configuration.c"
		"${MPDir}/vo-aacenc/aacenc/src/psy_main.c"
		"${MPDir}/vo-aacenc/aacenc/src/qc_main.c"
		"${MPDir}/vo-aacenc/aacenc/src/quantize.c"
		"${MPDir}/vo-aacenc/aacenc/src/sf_estim.c"
		"${MPDir}/vo-aacenc/aacenc/src/spreading.c"
		"${MPDir}/vo-aacenc/aacenc/src/stat_bits.c"
		"${MPDir}/vo-aacenc/aacenc/src/tns.c"
		"${MPDir}/vo-aacenc/aacenc/src/transform.c")
	set_source_files_properties(${MPVanillaRendererVoAacFiles} PROPERTIES
		COMPILE_FLAGS "-I${MPDir}/vo-aacenc/common/include -I${MPDir}/vo-aacenc/aacenc/inc -I${MPDir}/vo-aacenc/aacenc/basic_op -Wno-parentheses-equality")
	source_group("vo-aacenc" FILES ${MPVanillaRendererVoAacFiles})
	set(MPVanillaRendererFiles ${MPVanillaRendererFiles} ${MPVanillaRendererVoAacFiles})
	set_source_files_properties("${MPDir}/rd-vanilla/tr_mme_mp4.cpp" PROPERTIES
		COMPILE_FLAGS "-I${MPDir}/vo-aacenc/common/include")
endif()

if(UseInternalZlib)
	set(MPVanillaRendererIncludeDirectories ${MPVanillaRendererIncludeDirectories} "${MPDir}/zlib")
	if(WIN32)
		find_library(ZlibLibrary NAMES zlib PATHS "${MPDir}/libs/win32/lib")
		set(MPVanillaRendererLibraries ${MPVanillaRendererLibraries} ${ZlibLibrary})
	elseif(NOT EMSCRIPTEN)
		set(MPVanillaRendererLibraries ${MPVanillaRendererLibraries} bundled_zlib)
	endif()
else(UseInternalZlib)
	find_package(ZLIB REQUIRED)
	set(MPVanillaRendererIncludeDirectories ${MPVanillaRendererIncludeDirectories} ${ZLIB_INCLUDE_DIR})
	set(MPVanillaRendererLibraries ${MPVanillaRendererLibraries} ${ZLIB_LIBRARY})
endif(UseInternalZlib)

if(NOT WIN32 AND NOT EMSCRIPTEN)
	find_package(OpenGL REQUIRED)
	set(MPVanillaRendererIncludeDirectories ${MPVanillaRendererIncludeDirectories} ${OPENGL_INCLUDE_DIR})
	set(MPVanillaRendererLibraries ${MPVanillaRendererLibraries} ${OPENGL_LIBRARIES})

	find_package(SDL2 REQUIRED)
	set(MPVanillaRendererIncludeDirectories ${MPVanillaRendererIncludeDirectories} ${SDL2_INCLUDE_DIR})
	set(MPVanillaRendererLibraries ${MPVanillaRendererLibraries} ${SDL2_LIBRARY})
endif(NOT WIN32 AND NOT EMSCRIPTEN)


if(WIN32)
	set(MPVanillaRendererWin32Files
		"${MPDir}/win32/win_gamma.cpp"
		"${MPDir}/win32/win_glimp.cpp"
		"${MPDir}/win32/win_qgl.cpp")
	source_group("win32" FILES ${MPVanillaRendererWin32Files})
	set(MPVanillaRendererFiles ${MPVanillaRendererFiles} ${MPVanillaRendererWin32Files})
else(WIN32)
	set(MPVanillaRendererSysFiles
		"${MPDir}/sdl/sdl_glimp.cpp")
	source_group("sys" FILES ${MPVanillaRendererSysFiles})
	set(MPVanillaRendererFiles ${MPVanillaRendererFiles} ${MPVanillaRendererSysFiles})
endif(WIN32)

if(EMSCRIPTEN)
	add_library(${jaMMERenderer} STATIC ${MPVanillaRendererFiles})
	target_compile_options(${jaMMERenderer} PRIVATE -sUSE_SDL=2)
else()
	add_library(${jaMMERenderer} SHARED ${MPVanillaRendererFiles})
endif()

if(NOT WIN32)
	# remove "lib" prefix for .so/.dylib files
	set_target_properties(${jaMMERenderer} PROPERTIES PREFIX "")
endif(NOT WIN32)

if(WIN32)
	install(TARGETS ${jaMMERenderer} RUNTIME DESTINATION "${jaMMEInstallDir}")
elseif(NOT EMSCRIPTEN)
	if(MakeApplicationBundles AND BuildMPEngine)
		install(TARGETS ${jaMMERenderer} LIBRARY DESTINATION "${jaMMEEngine}.app/Contents/MacOS/")
	else(MakeApplicationBundles AND BuildMPEngine)
		install(TARGETS ${jaMMERenderer} LIBRARY DESTINATION "${jaMMEInstallDir}")
	endif(MakeApplicationBundles AND BuildMPEngine)
endif(WIN32)
set_target_properties(${jaMMERenderer} PROPERTIES COMPILE_DEFINITIONS "${SharedDefines}")
set_target_properties(${jaMMERenderer} PROPERTIES INCLUDE_DIRECTORIES "${MPVanillaRendererIncludeDirectories}")
if(NOT EMSCRIPTEN)
	target_link_libraries(${jaMMERenderer} ${MPVanillaRendererLibraries})
endif()
