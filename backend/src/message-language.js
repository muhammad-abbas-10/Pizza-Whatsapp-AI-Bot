function detectMessageLanguage(currentMessage, recentMessages = []) {
  const detectClearLanguage = (value) => {
    const text = String(value || "").trim();
    if (!text) return null;
    const lower = text.toLowerCase();

    const pashtoScript = /[ځڅډړږښګڼۍې]/u.test(text);
    const pashtoWords = /(?:^|\s)(?:زه|زما|مونږ|موږ|تاسو|ستا|څه|څنګه|غواړم|غواړو|شته|نشته|راکړه|راکړئ|کوم|کړم|کړئ|ډېر|چرګ)(?:\s|$|[؟?!.,])/u.test(text);
    if (pashtoScript || pashtoWords) return "pashto";

    if (/[\u0600-\u06ff]/u.test(text)) return "urdu";

    const romanUrdu = /\b(?:aap|apka|aapka|mera|meri|mujhe|hum|ham|hai|hain|nahi|nahin|haan|han|jee|ji|acha|theek|shukriya|bhai|madad|dikhao|dikhado|bhejo|bhej|sakte|chahiye|chahta|chahti|kitna|kitni|kitne|kitny|ka|ki|ke|wala|wali|karna|karo|kardo|krdo|mein|mai|dair|hogi|hoga|yeh|ye|wo|aur|salam|salaam|aoa|assalam)\b/i;
    if (romanUrdu.test(lower)) return "roman_urdu";

    if (/\b(?:yes|no|thanks|thank\s+you|hello|hi|hey|please|show|want|need|how|what|can|could|would|order|place|cancel|see|give|send|one|the|a|an|is|are|do|me|my|your)\b/i.test(lower)) {
      return "english";
    }

    if (/^(?:ok|okay|k|👍|👌|✅|\d+)$/iu.test(lower)) return null;
    if (/^[a-z][a-z\s'’-]*$/i.test(text)) return "english";
    return null;
  };

  const current = detectClearLanguage(currentMessage);
  if (current) return current;

  const history = Array.isArray(recentMessages) ? recentMessages : [];
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const entry = history[index];
    if (!entry || entry.role !== "customer") continue;
    const historical = detectClearLanguage(entry.text);
    if (historical) return historical;
  }

  return "english";
}

module.exports = { detectMessageLanguage };
