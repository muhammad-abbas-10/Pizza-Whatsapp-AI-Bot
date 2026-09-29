const { parseFeedback } = require("./feedback-parser");

const FEEDBACK_WINDOW_MS = 24 * 60 * 60 * 1000;

function hasRecentFeedbackRequest(requestedAt, now) {
  const timestamp = Date.parse(String(requestedAt || ""));
  return Number.isFinite(timestamp)
    && timestamp <= now
    && now - timestamp <= FEEDBACK_WINDOW_MS;
}

function classifyPendingFeedback(input, { requestedAt, now = Date.now() } = {}) {
  const text = String(input || "").trim().slice(0, 2000);
  const feedbackWindowOpen = hasRecentFeedbackRequest(requestedAt, now);
  const parsed = parseFeedback(text);

  // A rating prompt must never take over the conversation.  A request to order,
  // ask a normal question, or report an operational problem wins over feedback.
  const generalRequest = /(?:\?|\b(?:want|would\s+like|i'?d\s+like|place|add|buy|get|need|send|deliver|delivery|pickup|pick\s*up|show|menu|price|cost|how\s+much|available|cancel|change|modify|track|where(?:'s|\s+is)|status)\b|(?:آرڈر\s*(?:کرنا|کر\s*دیں|دینا)|مینو|دکھائیں|دکھاو|بھیجیں|بھیجو|قیمت|کتنے\s*کا|ڈیلیوری|پک\s*اپ|منسوخ|کینسل)|(?:order\s*(?:karna|karo|kardo)|menu\s*(?:dikhao|bhejo)|kitna|kitni|delivery|pickup|cancel)|(?:آرډر\s*(?:کول|کړئ)|مېنو|بیه|ډیليوري|لغوه))/iu.test(text);
  const directOrderRequest = /(?:\b(?:want|would\s+like|i'?d\s+like|place|add|buy)\b|\b(?:need|send)\s+(?:me\s+)?(?:a|an|some|\d+)\b|(?:آرڈر\s*(?:کرنا|کر\s*دیں|دینا)|مینو|دکھائیں|دکھاو|بھیجیں|بھیجو|ڈیلیوری|پک\s*اپ)|(?:order\s*(?:karna|karo|kardo)|menu\s*(?:dikhao|bhejo)|delivery|pickup)|(?:آرډر\s*(?:کول|کړئ)|مېنو|ډیليوري))/iu.test(text);
  const complaint = /(?:\b(?:did(?:\s+not|n't)\s+(?:receive|get)|not\s+(?:receive|delivered|arrive)|never\s+(?:received|arrived)|missing|wrong\s+(?:item|order|pizza)?|cold|late|delay(?:ed)?|refund|overcharg\w*|extra\s+charge|raw|burnt|stale|spoiled|allerg\w*|damaged|rude|terrible|awful|disappoint\w*|not\s+good|poor)\b|(?:nahi|nahin)\s*(?:mila|aya|aaya|pohncha)|(?:galat|thanda|der|dair|late|refund|extra\s*(?:paisa|paise|charge)|kharab|kharaab|kacha|jala|masla|shikayat)|(?:نہیں|نہيں)\s*(?:ملا|آیا|پہنچا)|(?:غلط|ٹھنڈا|تاخیر|دیر|رقم\s*واپس|اضافی\s*چارج|خراب|کچا|جلا|مسئلہ|شکایت)|(?:نه\s*(?:دی\s*)?(?:رسېد|راغ|ترلاسه)|یخ|غلط|ځنډ|ناوخته|بیرته|شکایت|ستونزه))/iu.test(text);
  const explicitFeedback = parsed.rating !== null
    || /⭐/u.test(text)
    || /\b(?:feedback|review|rating|rate|score)\b|(?:رائے|ریٹنگ|درجہ|تجربہ|نظر)/iu.test(text);
  const positiveFeedback = /(?:\b(?:amazing|excellent|great|good|loved?|enjoy(?:ed)?|delicious|tasty|perfect|awesome|fantastic|nice)\b|(?:bohat\s*(?:acha|achha)|zabardast|mazedaar|lazeez|pasand\s+aya)|(?:بہت\s*اچھا|زبردست|مزے\s*دار|لذیذ|پسند\s*آیا)|(?:ډېر\s*(?:ښه|خوندور)|خوندور))/iu.test(text);

  let intent = "normal";
  if (feedbackWindowOpen) {
    if (complaint && !directOrderRequest) intent = explicitFeedback ? "feedback_complaint" : "complaint";
    else if (!generalRequest && (explicitFeedback || positiveFeedback)) intent = "feedback";
  }

  return {
    intent,
    feedbackWindowOpen,
    hasExplicitFeedback: explicitFeedback,
    isComplaint: complaint,
    text,
  };
}

module.exports = { FEEDBACK_WINDOW_MS, classifyPendingFeedback, hasRecentFeedbackRequest };
