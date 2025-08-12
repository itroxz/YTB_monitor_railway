function parseViewers(viewersHTML) {
  if (!viewersHTML) return 0;
  const s = String(viewersHTML).trim().toLowerCase();

  // Detect multiplier suffixes near the number
  const hasThousandSuffix = /\d[\d.,]*\s*[k]\b/i.test(s) || /\bmil\b/i.test(s);
  const hasMillionSuffix = /\d[\d.,]*\s*[m]\b/i.test(s) || /\bmi\b|milh(ão|oes|ões)/i.test(s);

  let multiplier = 1;
  if (hasMillionSuffix) multiplier = 1_000_000;
  else if (hasThousandSuffix) multiplier = 1_000;

  // Extract first numeric token
  const match = s.match(/[\d][\d.,]*/);
  if (!match) return 0;
  let numStr = match[0];

  if (multiplier > 1) {
    numStr = numStr.replace(/\s/g, '').replace(/,/g, '.');
    const parts = numStr.split('.');
    if (parts.length > 2) numStr = parts[0] + '.' + parts.slice(1).join('');
    const val = parseFloat(numStr);
    if (isNaN(val)) return 0;
    return Math.round(val * multiplier);
  } else {
    let temp = numStr;
    if (temp.includes('.') && temp.includes(',')) {
      temp = temp.replace(/\./g, '').replace(',', '.');
    } else if (temp.includes(',')) {
      if (/,\d{3}(\D|$)/.test(temp)) temp = temp.replace(/,/g, '');
      else temp = temp.replace(',', '.');
    } else if (temp.includes('.')) {
      if (/\.\d{3}(\D|$)/.test(temp)) temp = temp.replace(/\./g, '');
    }
    const val = parseFloat(temp);
    return isNaN(val) ? 0 : Math.round(val);
  }
}

module.exports = { parseViewers };
