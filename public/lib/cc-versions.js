// Pure version-history logic for ccRunFix()'s Auto-Fix Issues — extracted from public/index.html
// so it can be unit-tested without a DOM (see test/pure-logic.test.js). Loaded as a plain global
// script in the browser (the top-level function declarations define window._ccReplaceMatchingFence
// and window._ccComputeAppliedFix) and required as a CommonJS module in Node tests. No behavior
// change from the inline version this was extracted from.

// Locates the fenced code block in `text` whose trimmed inner content exactly matches
// oldCode.trim(), and returns text with that one block's inner content replaced by newCode (fence
// markers and language tag preserved) — or null if no matching block is found in this text at all.
function _ccReplaceMatchingFence(text,oldCode,newCode){
  var target=(oldCode||'').trim();
  if(!target)return null;
  var re=/```([^\n`]*)\n?([\s\S]*?)```/g,m;
  while((m=re.exec(text||''))!==null){
    if((m[2]||'').trim()===target){
      var tag=m[1]||'';
      var replacement='```'+tag+'\n'+newCode+'\n```';
      return text.slice(0,m.index)+replacement+text.slice(m.index+m[0].length);
    }
  }
  return null;
}
// Computes the result of applying a completed Auto-Fix Issues result to one message's content —
// matches pre/post files by filename, splices in whichever files actually originated in this
// message's own text (via _ccReplaceMatchingFence), and pushes the message's PRIOR content onto
// the version stack (capped at maxVersions, oldest dropped first) if anything actually changed.
// Pure: takes plain values including `ts` (the caller's own Date.now(), never called in here) and
// returns a plain result, no chatHistory/saveChat/DOM access — the caller (public/index.html's
// _ccApplyFixToMessage) owns all of that.
function _ccComputeAppliedFix(content,preFiles,postFiles,existingVersions,maxVersions,ts){
  var next=content;
  var changed=false;
  (preFiles||[]).forEach(function(pf){
    var post=(postFiles||[]).find(function(f){return f.filename===pf.filename;});
    if(!post||post.content===pf.content)return;
    var updated=_ccReplaceMatchingFence(next,pf.content,post.content);
    if(updated!==null){next=updated;changed=true;}
  });
  if(!changed)return{changed:false,newContent:content,newVersions:Array.isArray(existingVersions)?existingVersions:[]};
  var versions=(Array.isArray(existingVersions)?existingVersions.slice():[]);
  versions.push({content:content,ts:ts});
  if(versions.length>maxVersions)versions.shift();
  return{changed:true,newContent:next,newVersions:versions};
}
if(typeof module!=='undefined'&&module.exports){module.exports={_ccReplaceMatchingFence:_ccReplaceMatchingFence,_ccComputeAppliedFix:_ccComputeAppliedFix};}
