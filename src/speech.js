const DEFAULT_COUNTER = '1';

function getThaiVoice() {
  if (typeof window === 'undefined' || !('speechSynthesis' in window)) return null;
  const voices = window.speechSynthesis.getVoices();
  return voices.find(voice => voice.lang?.toLowerCase().startsWith('th')) || null;
}

function spellQueue(queue){
    return queue
      .replace(/([A-Za-z])/g," $1 ")
      .trim()
      .split(/\s+/)
      .map(part=>{
          if(/^[A-Za-z]$/.test(part)){
              return {
                  A:"เอ",B:"บี",C:"ซี",D:"ดี",E:"อี",
                  F:"เอฟ",G:"จี",H:"เอช",I:"ไอ",J:"เจ",
                  K:"เค",L:"แอล",M:"เอ็ม",N:"เอ็น",O:"โอ",
                  P:"พี",Q:"คิว",R:"อาร์",S:"เอส",T:"ที",
                  U:"ยู",V:"วี",W:"ดับเบิลยู",X:"เอ็กซ์",
                  Y:"วาย",Z:"แซด"
              }[part.toUpperCase()];
          }
          return part.split("").join(" ");
      })
      .join(" ");
}

/** Announce a queue number through the browser's built-in text-to-speech. */
export function speakQueue(ticket, counter = DEFAULT_COUNTER) {
  if (typeof window === 'undefined' || !ticket?.ticketCode || !('speechSynthesis' in window)) return false;
  const Utterance = window.SpeechSynthesisUtterance;
  if (!Utterance) return false;
  const queueCode = spellQueue(ticket.ticketCode)
  const point = ticket.currentPoint || ticket.servicePoint || counter;
  const utterance = new Utterance(`ขอเชิญหมายเลข
    ${queueCode} 
    ที่จุดบริการ
    ${point}`);;
  utterance.lang = 'th-TH';
  utterance.rate = 0.55;
  utterance.pitch = 1;
  const voice = getThaiVoice();
  if (voice) utterance.voice = voice;
  window.speechSynthesis.cancel();
  window.speechSynthesis.speak(utterance);
  return true;
}
