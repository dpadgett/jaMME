// Copyright (C) 1999-2000 Id Software, Inc.
//
// cg_snapshot.c -- things that happen on snapshot transition,
// not necessarily every single rendered frame

#include "cg_local.h"



/*
==================
CG_ResetEntity
==================
*/
static void CG_ResetEntity( centity_t *cent ) {
	// if the previous snapshot this entity was updated in is at least
	// an event window back in time then we can reset the previous event
	if ( cent->snapShotTime < cg.time - EVENT_VALID_MSEC ) {
		cent->previousEvent = 0;
	}

	cent->trailTime = cg.snap->serverTime;

	VectorCopy (cent->currentState.origin, cent->lerpOrigin);
	VectorCopy (cent->currentState.angles, cent->lerpAngles);

	if (cent->currentState.eFlags & EF_G2ANIMATING)
	{ //reset the animation state
		cent->pe.torso.animationNumber = -1;
		cent->pe.legs.animationNumber = -1;
	}

#if 0
	if (cent->isRagging && (cent->currentState.eFlags & EF_DEAD))
	{
		VectorAdd(cent->lerpOrigin, cent->lerpOriginOffset, cent->lerpOrigin);
	}
#endif

	if ( cent->currentState.eType == ET_PLAYER || cent->currentState.eType == ET_NPC ) {
		CG_ResetPlayerEntity( cent );
	}
}

/*
===============
CG_TransitionEntity

cent->nextState is moved to cent->currentState and events are fired
===============
*/
static void CG_TransitionEntity( centity_t *cent ) {
	cent->currentState = cent->nextState;
	cent->currentValid = qtrue;

	// reset if the entity wasn't in the last frame or was teleported
	if ( !cent->interpolate ) {
		CG_ResetEntity( cent );
	} else {	//mme
		int newHeight;
		int maxs = ((cent->currentState.solid >> 16) & 255) - 32;
		if ( maxs > 16 )
			newHeight = DEFAULT_VIEWHEIGHT;
		else
			newHeight = CROUCH_VIEWHEIGHT;

		if ( newHeight != cent->pe.viewHeight ) {
			cent->pe.duckTime = cg.snap->serverTime;
			cent->pe.duckChange = newHeight - cent->pe.viewHeight;
			cent->pe.viewHeight = newHeight;
		}
	}

	// clear the next state.  if will be set by the next CG_SetNextSnap
	cent->interpolate = qfalse;

	// check for events
	CG_CheckEvents( cent );
}

#define CMD_SMOOTH_W_PAST	150
#define CMD_SMOOTH_W_FUTURE	150

static int CG_MapCommandSmoothTime(
	int serverTime, int prevServerTime,
	int cmdTime, int prevCmdTime,
	int prevTime, qboolean isTeleport,
	double *clockOffset, qboolean *hasClockOffset )
{
	int dcmd, newTime, minTime, maxTime;

	if ( !*hasClockOffset || isTeleport || prevServerTime <= 0 || serverTime < prevServerTime ) {
		int t = serverTime;
		if ( isTeleport && prevServerTime > 0 && serverTime >= prevServerTime && t < prevTime ) {
			t = prevTime;
		}
		*clockOffset = (double)t - (double)cmdTime;
		*hasClockOffset = qtrue;
		return t;
	}

	dcmd = cmdTime - prevCmdTime;
	if ( dcmd < 0 ) {
		int t = Q_max( prevTime, serverTime );
		*clockOffset = (double)t - (double)cmdTime;
		return t;
	}

	if ( dcmd > 0 ) {
		double rawPred = (double)cmdTime + *clockOffset;
		double err = (double)serverTime - rawPred;
		double maxStep = 0.025 * (double)dcmd;
		double step = 0.04 * err;
		if ( maxStep < 0.5 ) {
			maxStep = 0.5;
		}
		if ( step > maxStep ) {
			step = maxStep;
		} else if ( step < -maxStep ) {
			step = -maxStep;
		}
		*clockOffset += step;
		newTime = (int)floor( (double)cmdTime + *clockOffset + 0.5 );
		if ( newTime <= prevTime ) {
			newTime = prevTime + 1;
			*clockOffset = (double)newTime - (double)cmdTime;
		}
	} else {
		newTime = prevTime;
	}

	minTime = serverTime - CMD_SMOOTH_W_PAST;
	maxTime = serverTime + CMD_SMOOTH_W_FUTURE;
	if ( newTime < minTime ) {
		newTime = Q_max( prevTime, minTime );
		*clockOffset = (double)newTime - (double)cmdTime;
	} else if ( newTime > maxTime ) {
		newTime = Q_max( prevTime, maxTime );
		*clockOffset = (double)newTime - (double)cmdTime;
	}

	return newTime;
}

void CG_ResetCommandSmoothHistory( void ) {
	int i;
	cg.psHistory.nextSlot = 0;
	cg.psHistory.clockOffset = 0.0;
	cg.psHistory.hasClockOffset = qfalse;
	cg.currentPsHistory = 0;
	cg.numFutureSnaps = 0;
	cg.historySnapSeq = 0;
	for ( i = 0; i < MAX_SMOOTH_LOOKAHEAD_SNAPS; i++ ) {
		cg.futureSnaps[i] = NULL;
	}
	for ( i = 0; i < MAX_GENTITIES; i++ ) {
		cg_entities[i].stateHistory.nextSlot = 0;
		cg_entities[i].stateHistory.clockOffset = 0.0;
		cg_entities[i].stateHistory.hasClockOffset = qfalse;
		cg_entities[i].currentStateHistory = 0;
	}
}

void CG_AddToHistory( int serverTime, int snapSeq, entityState_t *state, centity_t *cent ) {
	timedEntityState_t *tstate = &cent->stateHistory.states[cent->stateHistory.nextSlot % MAX_STATE_HISTORY], *prev = NULL;
	qboolean pvsGap = qfalse;
	if ( cg.demoPlayback != 2 ) {
		return;
	}
	if ( state->number >= MAX_CLIENTS && state->eType != ET_MOVER ) {
		return;
	}
	if ( cent->stateHistory.nextSlot > 0 ) {
		prev = &cent->stateHistory.states[(cent->stateHistory.nextSlot - 1) % MAX_STATE_HISTORY];
		if ( prev->serverTime == serverTime ) {
			// already have this snap recorded
			return;
		}
		if ( prev->serverTime > serverTime ) {
			// jumped back in time
			cent->currentStateHistory = cent->stateHistory.nextSlot;
			cent->stateHistory.hasClockOffset = qfalse;
		} else if ( snapSeq - prev->snapSeq > 1 ) {
			pvsGap = qtrue;
			if ( state->number < MAX_CLIENTS && cent->currentStateHistory < cent->stateHistory.nextSlot ) {
				int activeTime = cg.snap ? cg.snap->serverTime : serverTime;
				if ( cent->stateHistory.states[cent->currentStateHistory % MAX_STATE_HISTORY].serverTime < activeTime ) {
					cent->currentStateHistory = cent->stateHistory.nextSlot;
				}
			}
		}
	}
	tstate->es = *state;
	tstate->serverTime = serverTime;
	tstate->snapSeq = snapSeq;
	tstate->isTeleport = ( cent->stateHistory.nextSlot <= 0 ||
		( prev && prev->serverTime > serverTime ) ||
		pvsGap ||
		( prev && prev->es.eType != state->eType ) ||
		( prev && ( ( prev->es.eFlags ^ state->eFlags ) & EF_TELEPORT_BIT ) ) ) ? qtrue : qfalse;

	if ( state->number < MAX_CLIENTS && state->eType == ET_PLAYER && state->pos.trType == TR_LINEAR_STOP ) {
		tstate->time = CG_MapCommandSmoothTime(
			serverTime,
			prev ? prev->serverTime : 0,
			state->pos.trTime,
			prev ? prev->es.pos.trTime : 0,
			prev ? prev->time : 0,
			tstate->isTeleport,
			&cent->stateHistory.clockOffset,
			&cent->stateHistory.hasClockOffset );
	} else {
		cent->stateHistory.hasClockOffset = qfalse;
		tstate->time = serverTime;
		if ( prev && prev->serverTime <= serverTime && tstate->time < prev->time ) {
			tstate->time = prev->time;
		}
	}

	if ( ( cent->stateHistory.nextSlot % MAX_STATE_HISTORY ) == ( cent->currentStateHistory % MAX_STATE_HISTORY ) && cent->currentStateHistory < cent->stateHistory.nextSlot ) {
		// buffer overflowed, force advance
		cent->currentStateHistory = cent->stateHistory.nextSlot - MAX_STATE_HISTORY + 1;
	}
	cent->stateHistory.nextSlot++;
}

void CG_UpdateTps( snapshot_t *snap, qboolean isTeleport ) {
	timedPlayerState_t	*tps, *lasttps = NULL;

	tps = &cg.psHistory.states[cg.psHistory.nextSlot % MAX_STATE_HISTORY];
	if ( cg.psHistory.nextSlot > 0 ) {
		lasttps = &cg.psHistory.states[( cg.psHistory.nextSlot - 1 ) % MAX_STATE_HISTORY];
		if ( lasttps->serverTime == snap->serverTime ) {
			// already have this snap recorded
			return;
		}
		if ( lasttps->serverTime > snap->serverTime ) {
			// jumped back in time
			cg.currentPsHistory = cg.psHistory.nextSlot;
			cg.psHistory.hasClockOffset = qfalse;
		}
	}
	
	tps->ps = snap->ps;
	tps->serverTime = snap->serverTime;
	tps->isTeleport = isTeleport;
	tps->time = CG_MapCommandSmoothTime(
		snap->serverTime,
		lasttps ? lasttps->serverTime : 0,
		snap->ps.commandTime,
		lasttps ? lasttps->ps.commandTime : 0,
		lasttps ? lasttps->time : 0,
		isTeleport,
		&cg.psHistory.clockOffset,
		&cg.psHistory.hasClockOffset );

	if ( ( cg.psHistory.nextSlot % MAX_STATE_HISTORY ) == ( cg.currentPsHistory % MAX_STATE_HISTORY ) && cg.currentPsHistory < cg.psHistory.nextSlot ) {
		// buffer overflowed, force advance
#ifdef _DEBUG
		if (cg_commandSmooth.integer)
			Com_Printf( "ps buffer overflow\n" );
#endif
		cg.currentPsHistory = cg.psHistory.nextSlot - MAX_STATE_HISTORY + 1;
	}
	cg.psHistory.nextSlot++;
}

/*
==================
CG_SetInitialSnapshot

This will only happen on the very first snapshot, or
on tourney restarts.  All other times will use 
CG_TransitionSnapshot instead.

FIXME: Also called by map_restart?
==================
*/
void CG_SetInitialSnapshot( snapshot_t *snap ) {
	int				i;
	centity_t		*cent;
	entityState_t	*state;

	cg.snap = snap; 

	if ((cg_entities[snap->ps.clientNum].ghoul2 == NULL) && trap_G2_HaveWeGhoul2Models(cgs.clientinfo[snap->ps.clientNum].ghoul2Model))
	{
		trap_G2API_DuplicateGhoul2Instance(cgs.clientinfo[snap->ps.clientNum].ghoul2Model, &cg_entities[snap->ps.clientNum].ghoul2);
		CG_CopyG2WeaponInstance(&cg_entities[snap->ps.clientNum], FIRST_WEAPON, cg_entities[snap->ps.clientNum].ghoul2);
		
		if (trap_G2API_AddBolt(cg_entities[snap->ps.clientNum].ghoul2, 0, "face") == -1)
		{ //check now to see if we have this bone for setting anims and such
			cg_entities[snap->ps.clientNum].noFace = qtrue;
		}
	}
	BG_PlayerStateToEntityState( &snap->ps, &cg_entities[ snap->ps.clientNum ].currentState, qfalse );

	// sort out solid entities
	CG_BuildSolidList();

	CG_ExecuteNewServerCommands( snap->serverCommandSequence );

	// set our local weapon selection pointer to
	// what the server has indicated the current weapon is
	CG_Respawn();

	if (cg.demoPlayback == 2) {
		CG_RecordSnapshotHistory(NULL, snap);
	} else if (!cg.demoPlayback) {
		// init force selection to SPEED
		cg.forceSelect = cg.snap->ps.fd.forcePowerSelected = FP_SPEED;
		trap_SetUserCmdValue(cg.weaponSelect, cg.zoomSensitivity, 0.0f, 0.0f, 0.0f, cg.forceSelect, cg.itemSelect, qfalse);
	}

	for ( i = 0 ; i < cg.snap->numEntities ; i++ ) {
		state = &cg.snap->entities[ i ];
		cent = &cg_entities[ state->number ];

		memcpy(&cent->currentState, state, sizeof(entityState_t));
		//cent->currentState = *state;
		cent->interpolate = qfalse;
		cent->currentValid = qtrue;

		CG_ResetEntity( cent );

		// check for events
		CG_CheckEvents( cent );
	}
}

static qboolean CG_IsTeleport( snapshot_t *lastSnap, snapshot_t *snap ) {
	if ( !lastSnap ) {
		return qtrue;
	}

	// if the next frame is a teleport for the playerstate, we
	// can't interpolate during demos
	if ( ( snap->ps.eFlags ^ lastSnap->ps.eFlags ) & EF_TELEPORT_BIT ) {
		return qtrue;
	}

	// if changing follow mode, don't interpolate
	if ( snap->ps.clientNum != lastSnap->ps.clientNum ) {
		return qtrue;
	}

	// if changing server restarts, don't interpolate
	if ( ( snap->snapFlags ^ lastSnap->snapFlags ) & SNAPFLAG_SERVERCOUNT ) {
		return qtrue;
	}

	// intermission or spectator transitions do not always toggle EF_TELEPORT_BIT
	if ( ( snap->ps.pm_type == PM_INTERMISSION ) != ( lastSnap->ps.pm_type == PM_INTERMISSION ) ) {
		return qtrue;
	}
	if ( ( snap->ps.pm_type == PM_SPECTATOR ) != ( lastSnap->ps.pm_type == PM_SPECTATOR ) ) {
		return qtrue;
	}

	if ( snap->ps.commandTime < lastSnap->ps.commandTime ) {
		return qtrue;
	}

	// POV-rewritten demos (e.g. DemoChanger) can freeze ps while target is out of PVS, then jump without EF_TELEPORT_BIT
	if ( snap->ps.commandTime - lastSnap->ps.commandTime > 1500 ) {
		vec3_t delta;
		VectorSubtract( snap->ps.origin, lastSnap->ps.origin, delta );
		if ( VectorLengthSquared( delta ) > ( 256.0f * 256.0f ) ) {
			return qtrue;
		}
	}

	return qfalse;
}

void CG_RecordSnapshotHistory( snapshot_t *prevSnap, snapshot_t *snap ) {
	int num;
	entityState_t pes;
	if ( cg.demoPlayback != 2 || !snap ) {
		return;
	}
	if ( cg.psHistory.nextSlot > 0 &&
		cg.psHistory.states[( cg.psHistory.nextSlot - 1 ) % MAX_STATE_HISTORY].serverTime == snap->serverTime ) {
		return;
	}
	cg.historySnapSeq++;
	CG_UpdateTps( snap, CG_IsTeleport( prevSnap, snap ) );
	BG_PlayerStateToEntityStateExtraPolate( &snap->ps, &pes, snap->ps.commandTime, qfalse );
	CG_AddToHistory( snap->serverTime, cg.historySnapSeq, &pes, &cg_entities[snap->ps.clientNum] );
	for ( num = 0; num < snap->numEntities; num++ ) {
		entityState_t *es = &snap->entities[num];
		CG_AddToHistory( snap->serverTime, cg.historySnapSeq, es, &cg_entities[es->number] );
	}
}

/*
===================
CG_SetNextSnap

A new snapshot has just been read in from the client system.
===================
*/
static void CG_SetNextSnapInternal( snapshot_t *snap, qboolean recordHistory ) {
	int					num;
	entityState_t		*es;
	centity_t			*cent;

	cg.nextSnap = snap;

	BG_PlayerStateToEntityState( &snap->ps, &cg_entities[ snap->ps.clientNum ].nextState, qfalse );

	// check for extrapolation errors
	for ( num = 0 ; num < snap->numEntities ; num++ ) 
	{
		es = &snap->entities[num];
		cent = &cg_entities[ es->number ];

		memcpy(&cent->nextState, es, sizeof(entityState_t));

		// if this frame is a teleport, or the entity wasn't in the
		// previous frame, don't interpolate
		if ( !cent->currentValid || ( ( cent->currentState.eFlags ^ es->eFlags ) & EF_TELEPORT_BIT )  ) {
			cent->interpolate = qfalse;
		} else {
			cent->interpolate = qtrue;
		}
	}

	cg.nextFrameTeleport = CG_IsTeleport( cg.snap, snap );

	if ( recordHistory && cg.demoPlayback == 2 ) {
		CG_RecordSnapshotHistory( cg.snap, snap );
	}

	// sort out solid entities
	CG_BuildSolidList();
}

void CG_SetNextSnap( snapshot_t *snap ) {
	CG_SetNextSnapInternal( snap, qtrue );
}

void CG_PushFutureSnap( snapshot_t *snap ) {
	snapshot_t *prevSnap;
	if ( !snap || cg.numFutureSnaps >= MAX_SMOOTH_LOOKAHEAD_SNAPS ) {
		return;
	}
	prevSnap = ( cg.numFutureSnaps > 0 ) ? cg.futureSnaps[cg.numFutureSnaps - 1] : cg.nextSnap;
	cg.futureSnaps[cg.numFutureSnaps++] = snap;
	CG_RecordSnapshotHistory( prevSnap, snap );
}

/*
===================
CG_TransitionSnapshot

The transition point from snap to nextSnap has passed
===================
*/
extern qboolean CG_UsingEWeb(void); //cg_predict.c
void CG_TransitionSnapshot( void ) {
	centity_t			*cent;
	snapshot_t			*oldFrame;
	int					i;

	if ( !cg.snap ) {
		CG_Error( "CG_TransitionSnapshot: NULL cg.snap" );
	}
	if ( !cg.nextSnap ) {
		CG_Error( "CG_TransitionSnapshot: NULL cg.nextSnap" );
	}

	// execute any server string commands before transitioning entities
	CG_ExecuteNewServerCommands( cg.nextSnap->serverCommandSequence );

	// if we had a map_restart, set everthing with initial
	if ( !cg.snap ) {
	}

	// clear the currentValid flag for all entities in the existing snapshot
	for ( i = 0 ; i < cg.snap->numEntities ; i++ ) {
		cent = &cg_entities[ cg.snap->entities[ i ].number ];
		cent->currentValid = qfalse;
	}

	// move nextSnap to snap and do the transitions
	oldFrame = cg.snap;
	cg.snap = cg.nextSnap;

	//CG_CheckPlayerG2Weapons(&cg.snap->ps, &cg_entities[cg.snap->ps.clientNum]);
	//CG_CheckPlayerG2Weapons(&cg.snap->ps, &cg.predictedPlayerEntity);
	BG_PlayerStateToEntityState( &cg.snap->ps, &cg_entities[ cg.snap->ps.clientNum ].currentState, qfalse );
	cg_entities[ cg.snap->ps.clientNum ].interpolate = qfalse;

	for ( i = 0 ; i < cg.snap->numEntities ; i++ ) {
		cent = &cg_entities[ cg.snap->entities[ i ].number ];
		CG_TransitionEntity( cent );

		// remember time of snapshot this entity was last updated in
		cent->snapShotTime = cg.snap->serverTime;
	}

	if ( cg.numFutureSnaps <= 0 ) {
		cg.nextSnap = NULL;
	} else {
		snapshot_t *promoted = cg.futureSnaps[0];
		int fIdx;
		for ( fIdx = 1; fIdx < cg.numFutureSnaps; fIdx++ ) {
			cg.futureSnaps[fIdx - 1] = cg.futureSnaps[fIdx];
		}
		cg.futureSnaps[cg.numFutureSnaps - 1] = NULL;
		cg.numFutureSnaps--;
		CG_SetNextSnapInternal( promoted, qfalse );
	}

	// check for playerstate transition events
	if ( oldFrame ) {
		playerState_t	*ops, *ps;

		ops = &oldFrame->ps;
		ps = &cg.snap->ps;
		// teleporting checks are irrespective of prediction
		if ( ( ps->eFlags ^ ops->eFlags ) & EF_TELEPORT_BIT ) {
			cg.thisFrameTeleport = qtrue;	// will be cleared by prediction code
		}

		// if we are not doing client side movement prediction for any
		// reason, then the client events and view changes will be issued now
		if ( cg.demoPlayback || (cg.snap->ps.pm_flags & PMF_FOLLOW)
			|| cg_noPredict.integer || g_synchronousClients.integer || CG_UsingEWeb() ) {
			CG_TransitionPlayerState( ps, ops );
		}
	}

}

/*
========================
CG_ReadNextSnapshot

This is the only place new snapshots are requested
This may increment cgs.processedSnapshotNum multiple
times if the client system fails to return a
valid snapshot.
========================
*/
snapshot_t *CG_ReadNextSnapshot( void ) {
	qboolean	r;
	snapshot_t	*dest;

	if ( cg.latestSnapshotNum > cgs.processedSnapshotNum + 1000 ) {
		CG_Printf( "WARNING: CG_ReadNextSnapshot: way out of range, %i > %i\n", 
			cg.latestSnapshotNum, cgs.processedSnapshotNum );
	}

	while ( cgs.processedSnapshotNum < cg.latestSnapshotNum ) {
		// decide which of the two slots to load it into
		if ( cg.demoPlayback != 2 && cg.snap == &cg.activeSnapshots[0] ) {
			dest = &cg.activeSnapshots[1];
		} else if ( cg.demoPlayback != 2 ) {
			dest = &cg.activeSnapshots[0];
		} else if ( !cg.snap ) {
			dest = &cg.activeSnapshots[0];
		} else {
			// pick slot not already used
			int curOffset, fIdx;
			dest = NULL;
			for ( curOffset = 0; curOffset < MAX_ACTIVE_SNAPSHOTS; curOffset++ ) {
				snapshot_t *cand = &cg.activeSnapshots[curOffset];
				qboolean inUse = ( cg.snap == cand ) || ( cg.nextSnap == cand );
				for ( fIdx = 0; !inUse && fIdx < cg.numFutureSnaps; fIdx++ ) {
					if ( cg.futureSnaps[fIdx] == cand ) {
						inUse = qtrue;
					}
				}
				if ( !inUse ) {
					dest = cand;
					break;
				}
			}
			if ( !dest ) {
				Com_Printf( "WARNING: Couldn't find unused activeSnapshot\n" );
				return NULL;
			}
		}

		// try to read the snapshot from the client system
		cgs.processedSnapshotNum++;
		r = trap_GetSnapshot( cgs.processedSnapshotNum, dest );

		// FIXME: why would trap_GetSnapshot return a snapshot with the same server time
		if ( r && cg.demoPlayback ) {
			snapshot_t *lastRead = ( cg.numFutureSnaps > 0 )
				? cg.futureSnaps[cg.numFutureSnaps - 1]
				: ( cg.nextSnap ? cg.nextSnap : cg.snap );
			if ( lastRead && dest->serverTime == lastRead->serverTime ) {
				continue;
			}
		}

		// if it succeeded, return
		if ( r ) {
			CG_AddLagometerSnapshotInfo( dest );
			return dest;
		}

		// a GetSnapshot will return failure if the snapshot
		// never arrived, or  is so old that its entities
		// have been shoved off the end of the circular
		// buffer in the client system.

		// record as a dropped packet
		CG_AddLagometerSnapshotInfo( NULL );

		// If there are additional snapshots, continue trying to
		// read them.
	}

	// nothing left to read
	return NULL;
}


/*
============
CG_ProcessSnapshots

We are trying to set up a renderable view, so determine
what the simulated time is, and try to get snapshots
both before and after that time if available.

If we don't have a valid cg.snap after exiting this function,
then a 3D game view cannot be rendered.  This should only happen
right after the initial connection.  After cg.snap has been valid
once, it will never turn invalid.

Even if cg.snap is valid, cg.nextSnap may not be, if the snapshot
hasn't arrived yet (it becomes an extrapolating situation instead
of an interpolating one)

============
*/
extern int cameraLastFrame;
extern void CG_TransitionPermanent( void );

void CG_ResetForDemoSeek( int serverCommandSeq, int processedSnapNum ) {
	int i, j, k;
	static char oldClientInfo[MAX_CLIENTS][MAX_STRING_CHARS];
	for ( i = 0; i < MAX_CLIENTS; i++ ) {
		Q_strncpyz( oldClientInfo[i], CG_ConfigString( CS_PLAYERS + i ), sizeof( oldClientInfo[i] ) );
	}
	cg.clientFrame = 0;
	cg.snap = NULL;
	cg.nextSnap = NULL;
	CG_ResetCommandSmoothHistory();
	cg.latestSnapshotNum = 0;
	cg.latestSnapshotTime = 0;
	cg.validPPS = qfalse;
	cg.thisFrameTeleport = qtrue;
	cg.nextFrameTeleport = qfalse;
	cg.frametime = 0;
	cg.oldTime = 0;
	cg.physicsTime = 0;
	VectorClear( cg.predictedError );
	cg.predictedErrorTime = 0;
	cg.zoomTime = 0;
	cg.damageTime = 0.0f;
	cg.damageX = 0.0f;
	cg.damageY = 0.0f;
	cg.damageValue = 0.0f;
	cg.v_dmg_time = 0.0f;
	cg.v_dmg_pitch = 0.0f;
	cg.v_dmg_roll = 0.0f;
	VectorClear( cg.kick_angles );
	cg.kick_time = 0;
	VectorClear( cg.kick_origin );
	cg.centerPrintTime = 0;
	cg.soundTime = 0;
	cg.soundBufferIn = 0;
	cg.soundBufferOut = 0;
	cg.voiceChatTime = 0;
	cg.voiceChatBufferIn = 0;
	cg.voiceChatBufferOut = 0;
	cg.itemPickupTime = 0;
	cg.itemPickupBlendTime = 0;
	cg.weaponSelectTime = 0;
	cg.weaponAnimationTime = 0;
	cg.headEndTime = 0;
	cg.headStartTime = 0;
	cg.nextOrbitTime = 0;
	CG_ResetThirdPersonCameraState();
	memset( &cgScreenEffects, 0, sizeof( cgScreenEffects ) );
	CG_InitLocalEntities();
	CG_InitMarkPolys();
	cgs.processedSnapshotNum = (processedSnapNum >= 0) ? processedSnapNum : 0;
	if ( serverCommandSeq >= 0 ) {
		cgs.serverCommandSequence = serverCommandSeq;
	}
	trap_GetGameState( &cgs.gameState );
	for ( i = 0; i < MAX_GENTITIES; i++ ) {
		cg_entities[i].currentValid = qfalse;
		cg_entities[i].interpolate = qfalse;
		cg_entities[i].muzzleFlashTime = 0;
		cg_entities[i].previousEvent = 0;
		cg_entities[i].trailTime = 0;
		cg_entities[i].dustTrailTime = 0;
		cg_entities[i].miscTime = 0;
		cg_entities[i].damageTime = 0;
		cg_entities[i].snapShotTime = 0;
		cg_entities[i].ragLastOriginTime = 0;
		cg_entities[i].frame_minus1_refreshed = 0;
		cg_entities[i].frame_minus2_refreshed = 0;
		cg_entities[i].frame_hold_time = 0;
		cg_entities[i].frame_hold_refreshed = 0;
		cg_entities[i].trickAlpha = 0;
		cg_entities[i].trickAlphaTime = 0;
		cg_entities[i].teamPowerEffectTime = 0;
		cg_entities[i].teamPowerType = 0;
		cg_entities[i].bodyFadeTime = 0;
		cg_entities[i].serverSaberHitTime = 0;
		cg_entities[i].vChatTime = 0;
		cg_entities[i].numLoopingSounds = 0;
		VectorClear( cg_entities[i].beamEnd );
		memset( &cg_entities[i].pe, 0, sizeof( cg_entities[i].pe ) );
	}
	CG_TransitionPermanent();
	CG_SetConfigValues();
	for ( i = 0; i < MAX_CLIENTS; i++ ) {
		const char *newStr = CG_ConfigString( CS_PLAYERS + i );
		cgs.clientinfo[i].medkitUsageTime = 0;
		cgs.clientinfo[i].breathPuffTime = 0;
		cgs.clientinfo[i].corrTime = 0;
		cgs.clientinfo[i].lookTime = 0;
		cgs.clientinfo[i].superSmoothTime = 0;
		for ( j = 0; j < MAX_SABERS; j++ ) {
			for ( k = 0; k < MAX_BLADES; k++ ) {
				cgs.clientinfo[i].saber[j].blade[k].trail.lastTime = 0;
				cgs.clientinfo[i].saber[j].blade[k].trail.inAction = qfalse;
			}
		}
		if ( strcmp( oldClientInfo[i], newStr ) != 0 ) {
			CG_NewClientInfo( i, qtrue );
		}
	}
}

void CG_GetDemoDebugState( float *outFloats, int maxCount ) {
	int clNum;
	if ( !outFloats || maxCount < 16 ) {
		return;
	}
	outFloats[0] = (float)cg.time;
	outFloats[1] = cg.snap ? (float)cg.snap->serverTime : 0.0f;
	outFloats[2] = cg.nextSnap ? (float)cg.nextSnap->serverTime : 0.0f;
	outFloats[3] = cg.snap ? (float)cg.snap->ps.clientNum : -1.0f;
	outFloats[4] = cg.snap ? cg.snap->ps.origin[0] : 0.0f;
	outFloats[5] = cg.snap ? cg.snap->ps.origin[1] : 0.0f;
	outFloats[6] = cg.snap ? cg.snap->ps.origin[2] : 0.0f;
	outFloats[7] = cg.predictedPlayerState.origin[0];
	outFloats[8] = cg.predictedPlayerState.origin[1];
	outFloats[9] = cg.predictedPlayerState.origin[2];
	outFloats[10] = cg.refdef.vieworg[0];
	outFloats[11] = cg.refdef.vieworg[1];
	outFloats[12] = cg.refdef.vieworg[2];
	clNum = cg.predictedPlayerState.clientNum;
	if ( clNum >= 0 && clNum < MAX_GENTITIES ) {
		outFloats[13] = cg_entities[clNum].lerpOrigin[0];
		outFloats[14] = cg_entities[clNum].lerpOrigin[1];
		outFloats[15] = cg_entities[clNum].lerpOrigin[2];
	} else {
		outFloats[13] = outFloats[14] = outFloats[15] = 0.0f;
	}
	if ( maxCount >= 20 ) {
		outFloats[16] = (float)cgs.media.bryarFrontFlash;
		outFloats[17] = (float)cgs.effects.bryarShotEffect;
		outFloats[18] = (float)cgs.effects.bryarPowerupShotEffect;
		outFloats[19] = (float)cg.renderingThirdPerson;
	}
}

void CG_ProcessSnapshots( void ) {
	snapshot_t		*snap;
	int				n;

	// see what the latest snapshot the client system has is
	trap_GetCurrentSnapshotNumber( &n, &cg.latestSnapshotTime );
	if ( n != cg.latestSnapshotNum ) {
		if ( n < cg.latestSnapshotNum ) {
			//do we need those?
			cg.snap = 0;
			cg.nextSnap = 0;
			cgs.processedSnapshotNum = -2;
//			// this should never happen
//			CG_Error( "CG_ProcessSnapshots: n < cg.latestSnapshotNum" );
		}
		cg.latestSnapshotNum = n;
	}

	// If we have yet to receive a snapshot, check for it.
	// Once we have gotten the first snapshot, cg.snap will
	// always have valid data for the rest of the game
	while ( !cg.snap ) {
		snap = CG_ReadNextSnapshot();
		if ( !snap ) {
			// we can't continue until we get a snapshot
			return;
		}

		// set our weapon selection to what
		// the playerstate is currently using
		if ( !( snap->snapFlags & SNAPFLAG_NOT_ACTIVE ) ) {
			CG_SetInitialSnapshot( snap );
		}
	}

	// loop until we either have a valid nextSnap with a serverTime
	// greater than cg.time to interpolate towards, or we run
	// out of available snapshots
	do {
		// if we don't have a nextframe, try and read a new one in
		if ( !cg.nextSnap ) {
			snap = CG_ReadNextSnapshot();

			// if we still don't have a nextframe, we will just have to
			// extrapolate
			if ( !snap ) {
				break;
			}

			CG_SetNextSnap( snap );


			// if time went backwards, we have a level restart
			if ( cg.nextSnap->serverTime < cg.snap->serverTime ) {
				CG_Error( "CG_ProcessSnapshots: Server time went backwards" );
			}
		}
		while ( cg.demoPlayback == 2 && cg.numFutureSnaps < MAX_SMOOTH_LOOKAHEAD_SNAPS ) {
			snapshot_t *prevFuture = ( cg.numFutureSnaps > 0 ) ? cg.futureSnaps[cg.numFutureSnaps - 1] : cg.nextSnap;
			snap = CG_ReadNextSnapshot();
			if ( !snap ) {
				break;
			}
			if ( prevFuture && snap->serverTime < prevFuture->serverTime ) {
				CG_Error( "CG_ProcessSnapshots: Server time went backwards" );
			}
			CG_PushFutureSnap( snap );
		}

		// if our time is < nextFrame's, we have a nice interpolating state
		if ( cg.time < cg.nextSnap->serverTime ) {
			break;
		}

		// we have passed the transition from nextFrame to frame
		CG_TransitionSnapshot();
	} while ( 1 );

	// assert our valid conditions upon exiting
	if ( cg.snap == NULL ) {
		CG_Error( "CG_ProcessSnapshots: cg.snap == NULL" );
	}
	if ( cg.time < cg.snap->serverTime ) {
		// this can happen right after a vid_restart
		cg.time = cg.snap->serverTime;
	}
	if ( cg.nextSnap != NULL && cg.nextSnap->serverTime <= cg.time ) {
		CG_Error( "CG_ProcessSnapshots: cg.nextSnap->serverTime <= cg.time" );
	}

}

