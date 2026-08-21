// Pure stitching-corruption detection logic for _abContinueBuild's truncation/continuation
// stitching in public/index.html — extracted so it can be unit-tested without a DOM (see
// test/pure-logic.test.js). Loaded as a plain global script in the browser and required as a
// CommonJS module in Node tests. No behavior change from the inline versions these were extracted
// from: each function only detects and returns a description of the corruption (or null if none
// found) — the console.log diagnostic and the _abContinueBuild retry itself stay exactly where
// they were, at the call sites in public/index.html.

var _AB_BLOCK_TAGS=['section','div','main','header','footer','nav','ul','ol','table','thead','tbody','form'];

// Tag-mismatch guard: the truncated chunk and its continuation can stitch into text that's
// individually plausible on both sides of the seam but structurally broken AT the seam — e.g. a
// closing </section> with no matching open tag anywhere in the joined code, because the
// continuation resumed at the wrong point. Babel throws a SyntaxError on this, surfaced to the
// user as a generic "Script error." with no useful detail. Deliberately narrow: a small whitelist
// of common block tags, and only an explicit mismatch fires (a closing tag whose name doesn't
// match the stack top, or an empty stack) — a tag still open at the end is NOT flagged, that's a
// much noisier signal prone to false positives on legitimately nested layouts.
function _abDetectTagMismatch(newCode,blockTags){
  var tagRe=new RegExp('<(\\/?)('+blockTags.join('|')+')\\b[^>]*?(\\/)?>','gi');
  var stack=[],mismatch=null,m;
  while((m=tagRe.exec(newCode))!==null){
    var isClose=!!m[1],tagName=m[2].toLowerCase(),selfClose=!!m[3];
    if(selfClose)continue;
    if(isClose){
      if(stack.length===0||stack[stack.length-1]!==tagName){
        mismatch='found </'+tagName+'> with no matching open tag';
        break;
      }
      stack.pop();
    }else{
      stack.push(tagName);
    }
  }
  return mismatch;
}

// Split-opening-tag guard: a third stitching-corruption variant — an OPENING tag itself lands
// across the truncation boundary (e.g. a lone "<" or a partial tag name at the very end of the
// truncated chunk, with the rest of the name resuming in the continuation). The tag-mismatch
// guard above can't see this: its regex requires the tag name to appear intact right after "<",
// so a split tag is simply invisible to that scan rather than flagged. Reconstructs what the
// split-off tag name would read as by joining any partial name left dangling at the end of
// infoCode with the start of verdictCode, then checks it against the same block-tag whitelist
// above. Deliberately narrow, same philosophy as both guards above: a bare "<" alone is never
// flagged on its own (it's also the less-than operator — flagging every dangling "<" would
// false-positive on ordinary comparisons like "x < 10"), only a reconstruction that matches a
// known tag name triggers. Scoped to a split tag NAME only, not a split landing inside
// attributes — that's a much looser pattern to detect without a high false-positive cost.
function _abDetectSplitOpeningTag(infoCode,verdictCode,blockTags){
  var dangleM=/<\/?([a-zA-Z]{0,10})$/.exec(infoCode.slice(-20));
  if(!dangleM)return null;
  var reconstructed=dangleM[1]+verdictCode.slice(0,20);
  var tagStartRe=new RegExp('^('+blockTags.join('|')+')\\b','i');
  return tagStartRe.test(reconstructed)?reconstructed.slice(0,20):null;
}

// JS-expression-mismatch guard: a different stitching-corruption class from the tag-mismatch
// guard above — the overlap-strip can consume real content along with genuine duplicate text,
// leaving a JSX attribute expression opener (={) immediately followed by unrelated code that
// starts with a bare closing delimiter — e.g. "onChange={" immediately followed by
// "e.target.value)}", where "e => setSearch(" was lost at the stitch seam. Deliberately narrow:
// only checks the very first non-whitespace character in a short window right after each ={, not
// a general paren/brace balance scan across the file — a real expression's first meaningful
// character is never a bare closing delimiter, so this has very low false-positive surface
// without needing to understand strings/regex/JSX text content at all.
function _abDetectExprMismatch(newCode){
  var exprRe=/=\{\s*/g;
  var exprM,mismatch=null;
  while((exprM=exprRe.exec(newCode))!==null){
    var start=exprM.index+exprM[0].length;
    var window=newCode.slice(start,start+100);
    var firstCharM=/\S/.exec(window);
    if(!firstCharM)continue;
    var firstChar=firstCharM[0];
    if(firstChar===')'||firstChar==='}'){
      mismatch='found bare closing delimiter "'+firstChar+'" immediately after ={';
      break;
    }
  }
  return mismatch;
}

if(typeof module!=='undefined'&&module.exports){
  module.exports={
    _AB_BLOCK_TAGS:_AB_BLOCK_TAGS,
    _abDetectTagMismatch:_abDetectTagMismatch,
    _abDetectSplitOpeningTag:_abDetectSplitOpeningTag,
    _abDetectExprMismatch:_abDetectExprMismatch
  };
}
