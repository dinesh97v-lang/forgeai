// Pure option-matching logic for App Builder guided-flow answers — extracted from
// public/index.html so it can be unit-tested without a DOM (see test/pure-logic.test.js). Loaded
// as a plain global script in the browser (the top-level function declaration defines
// window._abMatchOption) and required as a CommonJS module in Node tests. No behavior change from
// the inline version this was extracted from.
function _abMatchOption(t,options){
  var norm=(t||'').toLowerCase().trim();
  if(!norm)return null;
  var stripEmoji=function(s){return s.replace(/[\u{1F300}-\u{1FAFF}☀-➿]/gu,'').trim().toLowerCase();};
  for(var i=0;i<options.length;i++){if(options[i].toLowerCase()===norm)return options[i];}
  var normNoEmoji=stripEmoji(norm);
  for(var i=0;i<options.length;i++){if(stripEmoji(options[i])===normNoEmoji)return options[i];}
  // Word-level matching: an option's own word must equal, or be contained with >=50%
  // coverage in, some individual WORD of the typed input — not just appear anywhere as a raw
  // substring of the whole input string. \p{M} is required in the split below: Tamil vowel
  // signs and virama are Unicode category Mn/Mc, not \p{L}, so without \p{M} they'd be treated
  // as word separators and shatter Tamil words into meaningless fragments.
  var inputWords=normNoEmoji.split(/[^\p{L}\p{N}\p{M}]+/u).filter(Boolean);
  for(var i=0;i<options.length;i++){
    var words=stripEmoji(options[i]).split(/[\s\/]+/).filter(function(w){return w.length>2;});
    for(var j=0;j<words.length;j++){
      if(words[j].length/normNoEmoji.length>=0.25){
        for(var k=0;k<inputWords.length;k++){
          var w=inputWords[k];
          if(w===words[j]||(w.indexOf(words[j])!==-1&&words[j].length/w.length>=0.5)){return options[i];}
        }
      }
    }
  }
  return null;
}
if(typeof module!=='undefined'&&module.exports){module.exports={_abMatchOption:_abMatchOption};}
