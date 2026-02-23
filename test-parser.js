function parseSearchInput(raw) {
  let text = raw.trim();
  const fillerPhrases = [
    /^i need to find( new| local| some)?\s*/i,
    /^find( me| new| local| some)?\s*/i,
    /^looking for( new| local| some)?\s*/i,
    /^search for( new| local| some)?\s*/i,
    /^get me( new| local| some)?\s*/i,
    /^show me( new| local| some)?\s*/i,
    /^i want( to find)?\s*/i,
    /^can you find( me)?\s*/i,
  ];
  for (const re of fillerPhrases) text = text.replace(re, '');
  const locationMatch = text.match(/\b(?:in|near|around|at|within)\s+([A-Za-z\s]+?)(?:\s*$)/i);
  const location = locationMatch ? locationMatch[1].trim() : '';
  let businessType = text;
  if (locationMatch) businessType = text.slice(0, locationMatch.index).trim();
  const raw2 = businessType;
  businessType = businessType
    .replace(/\b(new|local|small|independent|nearby|businesses?|companies|tradespeople|tradespersons?)\b/gi, ' ')
    .replace(/\s{2,}/g, ' ').trim();
  if (!businessType) businessType = raw2.trim();

  // Last resort: if still no location, check if the final word looks like a place name
  if (!location) {
    const words = businessType.split(/\s+/);
    if (words.length >= 2) {
      const lastWord = words[words.length - 1];
      if (/^[A-Z]/.test(lastWord)) {
        return { businessType: words.slice(0, -1).join(' '), location: lastWord };
      }
    }
  }

  return { businessType, location };
}

const tests = [
  'I need to find new trade businesses in Chester',
  'plumbers in Manchester',
  'find me accountants near London',
  'looking for local electricians in Bristol',
  'roofers in Leeds',
  'I want to find small cleaning businesses in Birmingham',
  'can you find me solicitors near Liverpool',
  'new landscapers in Brighton',
  'tradespeople in Cardiff',
  'electrician Chester',
];

let pass = 0;
tests.forEach(t => {
  const r = parseSearchInput(t);
  const ok = r.businessType && r.location;
  console.log((ok ? '✅' : '❌') + '  "' + t + '"');
  console.log('      -> type: "' + r.businessType + '"  location: "' + r.location + '"');
  if (ok) pass++;
});
console.log('\n' + pass + '/' + tests.length + ' passed');
