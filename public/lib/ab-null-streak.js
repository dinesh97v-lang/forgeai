// Pure nullStreak (consecutive-unresolved-turn) counting logic for App Builder's mid-flow escape
// hatch — extracted from _abTrackStuckStep() in public/index.html so it can be unit-tested
// without a DOM (see test/pure-logic.test.js). Loaded as a plain global script in the browser and
// required as a CommonJS module in Node tests. No behavior change from the inline version this
// was extracted from: mutation-free, takes the CURRENT nullStreak value (or null/undefined) and
// the CURRENT step, returns the new nullStreak object plus whether the escape threshold has been
// reached. The caller is responsible for assigning the returned nullStreak back onto
// _abState.nullStreak and acting on `escalate` — this module never touches _abState itself. A
// real match advancing _abState.step naturally makes the OLD nullStreak's .step stale on the next
// call, so no explicit reset is needed at any match site — same as before extraction.
var _AB_ESCAPE_THRESHOLD=2;
function _abComputeNullStreak(nullStreak,step){
  var next=(nullStreak&&nullStreak.step===step)?{step:step,count:nullStreak.count+1}:{step:step,count:1};
  return {nullStreak:next,escalate:next.count>=_AB_ESCAPE_THRESHOLD};
}
if(typeof module!=='undefined'&&module.exports){module.exports={_abComputeNullStreak:_abComputeNullStreak,_AB_ESCAPE_THRESHOLD:_AB_ESCAPE_THRESHOLD};}
