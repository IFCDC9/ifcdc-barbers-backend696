/**
 * Customer-facing email UI strings (not booking/payment math).
 * English is always the fallback when a key or language is missing.
 */
function normalizeLang(language) {
  const raw = String(language || "").trim().replace(/_/g, "-");
  const lower = raw.toLowerCase();
  if (!lower) return "en";
  if (lower.startsWith("es")) return "es";
  if (lower.startsWith("fr")) return "fr";
  if (lower.startsWith("ht") || lower.startsWith("cpf") || lower === "creole") return "ht";
  if (lower.startsWith("pt")) return "pt";
  if (lower.startsWith("ar")) return "ar";
  if (lower.startsWith("he") || lower.startsWith("iw")) return "he";
  if (lower.startsWith("zh")) return "zh-CN";
  if (lower.startsWith("ko")) return "ko";
  if (lower.startsWith("vi")) return "vi";
  if (lower.startsWith("en")) return "en";
  return "en";
}

const EN = {
  reminderSubject: "Reminder — appointment in ~30 minutes",
  reminderHi: "Hi {{name}},",
  reminderBody:
    "This is a friendly reminder: you have an appointment around <strong>{{when}}</strong> with <strong>{{barber}}</strong> ({{service}}).",
  reminderSeeYou: "See you soon.",
  reminderText: "Hi {{name}}. Reminder: appointment ~{{when}}.",

  reviewSubject: "Your appointment is complete — rate {{barber}}",
  reviewTitle: "How was your experience?",
  reviewHi: "Hi {{name}},",
  reviewBody:
    "Your appointment is complete. How was your experience with <strong>{{barber}}</strong>? Tap below to leave a rating, review, and photos.",
  reviewCta: "Leave a review",
  reviewAppLink: "App link:",
  reviewNote: "Only clients with completed appointments can leave reviews — one review per booking.",

  refundSubject: "[IFCDC] Refund processed — ${{amount}}",
  refundTitle: "Refund confirmation",
  refundName: "Name",
  refundBarber: "Barber",
  refundService: "Service",
  refundDate: "Date",
  refundTime: "Time",
  refundStatus: "Status",
  refundAmount: "Refund amount",
  refundRef: "PayPal refund ref",
  refundReason: "Reason",
  refundFunds: "Funds typically return to your PayPal or card within 3–10 business days.",

  cancelSubject: "Appointment cancelled — IFCDC Barbers",
  cancelTitle: "Appointment cancelled",
  cancelBody: "Your appointment has been cancelled.",
  cancelWhen: "Originally scheduled",

  loyaltySubject: "Your IFCDC loyalty update",
  loyaltyBody:
    "Your IFCDC loyalty points were updated. Keep booking to unlock rewards.",
  loyaltyOpen: "Open IFCDC Barbers",
};

const TABLE = {
  es: {
    reminderSubject: "Recordatorio — cita en ~30 minutos",
    reminderHi: "Hola {{name}},",
    reminderBody:
      "Este es un recordatorio: tienes una cita alrededor de <strong>{{when}}</strong> con <strong>{{barber}}</strong> ({{service}}).",
    reminderSeeYou: "Nos vemos pronto.",
    reminderText: "Hola {{name}}. Recordatorio: cita ~{{when}}.",
    reviewSubject: "Tu cita está completa — califica a {{barber}}",
    reviewTitle: "¿Cómo fue tu experiencia?",
    reviewHi: "Hola {{name}},",
    reviewBody:
      "Tu cita está completa. ¿Cómo fue tu experiencia con <strong>{{barber}}</strong>? Toca abajo para dejar calificación, reseña y fotos.",
    reviewCta: "Dejar una reseña",
    reviewAppLink: "Enlace de la app:",
    reviewNote: "Solo clientes con citas completadas pueden dejar reseñas — una por reserva.",
    refundSubject: "[IFCDC] Reembolso procesado — ${{amount}}",
    refundTitle: "Confirmación de reembolso",
    refundName: "Nombre",
    refundBarber: "Barbero",
    refundService: "Servicio",
    refundDate: "Fecha",
    refundTime: "Hora",
    refundStatus: "Estado",
    refundAmount: "Monto del reembolso",
    refundRef: "Referencia de reembolso de PayPal",
    refundReason: "Motivo",
    refundFunds: "Los fondos suelen volver a tu PayPal o tarjeta en 3–10 días hábiles.",
    cancelSubject: "Cita cancelada — IFCDC Barbers",
    cancelTitle: "Cita cancelada",
    cancelBody: "Tu cita ha sido cancelada.",
    cancelWhen: "Programada originalmente",
    loyaltySubject: "Actualización de lealtad IFCDC",
    loyaltyBody: "Tus puntos de lealtad IFCDC se actualizaron. Sigue reservando para desbloquear recompensas.",
    loyaltyOpen: "Abrir IFCDC Barbers",
  },
  fr: {
    reminderSubject: "Rappel — rendez-vous dans ~30 minutes",
    reminderHi: "Bonjour {{name}},",
    reminderBody:
      "Petit rappel : vous avez un rendez-vous vers <strong>{{when}}</strong> avec <strong>{{barber}}</strong> ({{service}}).",
    reminderSeeYou: "À bientôt.",
    reminderText: "Bonjour {{name}}. Rappel : rendez-vous ~{{when}}.",
    reviewSubject: "Votre rendez-vous est terminé — notez {{barber}}",
    reviewTitle: "Comment s’est passée votre expérience ?",
    reviewHi: "Bonjour {{name}},",
    reviewBody:
      "Votre rendez-vous est terminé. Comment s’est passée votre expérience avec <strong>{{barber}}</strong> ? Appuyez ci-dessous pour laisser une note, un avis et des photos.",
    reviewCta: "Laisser un avis",
    reviewAppLink: "Lien de l’app :",
    reviewNote: "Seuls les clients avec un rendez-vous terminé peuvent laisser un avis — un avis par réservation.",
    refundSubject: "[IFCDC] Remboursement traité — ${{amount}}",
    refundTitle: "Confirmation de remboursement",
    refundName: "Nom",
    refundBarber: "Barbier",
    refundService: "Service",
    refundDate: "Date",
    refundTime: "Heure",
    refundStatus: "Statut",
    refundAmount: "Montant remboursé",
    refundRef: "Réf. remboursement PayPal",
    refundReason: "Motif",
    refundFunds: "Les fonds reviennent généralement sur PayPal ou votre carte sous 3 à 10 jours ouvrés.",
    cancelSubject: "Rendez-vous annulé — IFCDC Barbers",
    cancelTitle: "Rendez-vous annulé",
    cancelBody: "Votre rendez-vous a été annulé.",
    cancelWhen: "Initialement prévu",
    loyaltySubject: "Mise à jour fidélité IFCDC",
    loyaltyBody: "Vos points de fidélité IFCDC ont été mis à jour. Continuez à réserver pour débloquer des récompenses.",
    loyaltyOpen: "Ouvrir IFCDC Barbers",
  },
  ht: {
    reminderSubject: "Rapèl — randevou nan ~30 minit",
    reminderHi: "Bonjou {{name}},",
    reminderBody:
      "Sa se yon rapèl: ou gen yon randevou alantou <strong>{{when}}</strong> ak <strong>{{barber}}</strong> ({{service}}).",
    reminderSeeYou: "N a wè byento.",
    reminderText: "Bonjou {{name}}. Rapèl: randevou ~{{when}}.",
    reviewSubject: "Randevou ou fini — bay {{barber}} nòt",
    reviewTitle: "Kijan eksperyans ou te ye?",
    reviewHi: "Bonjou {{name}},",
    reviewBody:
      "Randevou ou fini. Kijan eksperyans ou te ye ak <strong>{{barber}}</strong>? Peze anba a pou kite nòt, revizyon, ak foto.",
    reviewCta: "Kite yon revizyon",
    reviewAppLink: "Lyen app:",
    reviewNote: "Se sèlman kliyan ki gen randevou fini ki ka kite revizyon — yon revizyon pou chak rezèvasyon.",
    refundSubject: "[IFCDC] Remèsman trete — ${{amount}}",
    refundTitle: "Konfimasyon remèsman",
    refundName: "Non",
    refundBarber: "Kowafè",
    refundService: "Sèvis",
    refundDate: "Dat",
    refundTime: "Lè",
    refundStatus: "Estati",
    refundAmount: "Montan remèsman",
    refundRef: "Referans remèsman PayPal",
    refundReason: "Rezon",
    refundFunds: "Lajan an anjeneral retounen nan PayPal oswa kat ou nan 3–10 jou ouvrab.",
    cancelSubject: "Randevou anile — IFCDC Barbers",
    cancelTitle: "Randevou anile",
    cancelBody: "Randevou ou anile.",
    cancelWhen: "Te pwograme orijinalman",
    loyaltySubject: "Mizajou fidelite IFCDC",
    loyaltyBody: "Pwen fidelite IFCDC ou yo te mete ajou. Kontinye rezève pou debloke rekonpans.",
    loyaltyOpen: "Louvri IFCDC Barbers",
  },
  pt: {
    reminderSubject: "Lembrete — consulta em ~30 minutos",
    reminderHi: "Olá {{name}},",
    reminderBody:
      "Este é um lembrete: você tem uma consulta por volta de <strong>{{when}}</strong> com <strong>{{barber}}</strong> ({{service}}).",
    reminderSeeYou: "Até breve.",
    reminderText: "Olá {{name}}. Lembrete: consulta ~{{when}}.",
    reviewSubject: "Sua consulta foi concluída — avalie {{barber}}",
    reviewTitle: "Como foi sua experiência?",
    reviewHi: "Olá {{name}},",
    reviewBody:
      "Sua consulta foi concluída. Como foi sua experiência com <strong>{{barber}}</strong>? Toque abaixo para deixar avaliação, comentário e fotos.",
    reviewCta: "Deixar uma avaliação",
    reviewAppLink: "Link do app:",
    reviewNote: "Somente clientes com consultas concluídas podem avaliar — uma avaliação por reserva.",
    refundSubject: "[IFCDC] Reembolso processado — ${{amount}}",
    refundTitle: "Confirmação de reembolso",
    refundName: "Nome",
    refundBarber: "Barbeiro",
    refundService: "Serviço",
    refundDate: "Data",
    refundTime: "Hora",
    refundStatus: "Status",
    refundAmount: "Valor do reembolso",
    refundRef: "Ref. de reembolso PayPal",
    refundReason: "Motivo",
    refundFunds: "Os valores geralmente retornam ao PayPal ou cartão em 3–10 dias úteis.",
    cancelSubject: "Consulta cancelada — IFCDC Barbers",
    cancelTitle: "Consulta cancelada",
    cancelBody: "Sua consulta foi cancelada.",
    cancelWhen: "Originalmente agendada",
    loyaltySubject: "Atualização de fidelidade IFCDC",
    loyaltyBody: "Seus pontos de fidelidade IFCDC foram atualizados. Continue agendando para desbloquear recompensas.",
    loyaltyOpen: "Abrir IFCDC Barbers",
  },
  ar: {
    reminderSubject: "تذكير — الموعد خلال ~30 دقيقة",
    reminderHi: "مرحبًا {{name}}،",
    reminderBody:
      "هذا تذكير ودي: لديك موعد حوالي <strong>{{when}}</strong> مع <strong>{{barber}}</strong> ({{service}}).",
    reminderSeeYou: "نراك قريبًا.",
    reminderText: "مرحبًا {{name}}. تذكير: موعد ~{{when}}.",
    reviewSubject: "اكتمل موعدك — قيّم {{barber}}",
    reviewTitle: "كيف كانت تجربتك؟",
    reviewHi: "مرحبًا {{name}}،",
    reviewBody:
      "اكتمل موعدك. كيف كانت تجربتك مع <strong>{{barber}}</strong>؟ اضغط أدناه لترك تقييم ومراجعة وصور.",
    reviewCta: "اترك مراجعة",
    reviewAppLink: "رابط التطبيق:",
    reviewNote: "يمكن فقط للعملاء الذين أكملوا المواعيد ترك مراجعات — مراجعة واحدة لكل حجز.",
    refundSubject: "[IFCDC] تمت معالجة الاسترداد — ${{amount}}",
    refundTitle: "تأكيد الاسترداد",
    refundName: "الاسم",
    refundBarber: "الحلاق",
    refundService: "الخدمة",
    refundDate: "التاريخ",
    refundTime: "الوقت",
    refundStatus: "الحالة",
    refundAmount: "مبلغ الاسترداد",
    refundRef: "مرجع استرداد PayPal",
    refundReason: "السبب",
    refundFunds: "عادةً تعود الأموال إلى PayPal أو بطاقتك خلال 3–10 أيام عمل.",
    cancelSubject: "تم إلغاء الموعد — IFCDC Barbers",
    cancelTitle: "تم إلغاء الموعد",
    cancelBody: "تم إلغاء موعدك.",
    cancelWhen: "كان مقررًا في الأصل",
    loyaltySubject: "تحديث ولاء IFCDC",
    loyaltyBody: "تم تحديث نقاط ولاء IFCDC الخاصة بك. واصل الحجز لفتح المكافآت.",
    loyaltyOpen: "افتح IFCDC Barbers",
  },
  he: {
    reminderSubject: "תזכורת — התור בעוד כ־30 דקות",
    reminderHi: "שלום {{name}},",
    reminderBody:
      "זו תזכורת ידידותית: יש לך תור בסביבות <strong>{{when}}</strong> עם <strong>{{barber}}</strong> ({{service}}).",
    reminderSeeYou: "נתראה בקרוב.",
    reminderText: "שלום {{name}}. תזכורת: תור ~{{when}}.",
    reviewSubject: "התור הושלם — דרגו את {{barber}}",
    reviewTitle: "איך הייתה החוויה?",
    reviewHi: "שלום {{name}},",
    reviewBody:
      "התור הושלם. איך הייתה החוויה עם <strong>{{barber}}</strong>? לחצו למטה כדי להשאיר דירוג, ביקורת ותמונות.",
    reviewCta: "השאירו ביקורת",
    reviewAppLink: "קישור לאפליקציה:",
    reviewNote: "רק לקוחות עם תורים שהושלמו יכולים להשאיר ביקורות — ביקורת אחת לכל הזמנה.",
    refundSubject: "[IFCDC] בוצע החזר — ${{amount}}",
    refundTitle: "אישור החזר",
    refundName: "שם",
    refundBarber: "ספר",
    refundService: "שירות",
    refundDate: "תאריך",
    refundTime: "שעה",
    refundStatus: "סטטוס",
    refundAmount: "סכום ההחזר",
    refundRef: "אסמכתת החזר PayPal",
    refundReason: "סיבה",
    refundFunds: "בדרך כלל הכספים חוזרים ל־PayPal או לכרטיס תוך 3–10 ימי עסקים.",
    cancelSubject: "התור בוטל — IFCDC Barbers",
    cancelTitle: "התור בוטל",
    cancelBody: "התור שלכם בוטל.",
    cancelWhen: "נקבע במקור ל",
    loyaltySubject: "עדכון נאמנות IFCDC",
    loyaltyBody: "נקודות הנאמנות שלכם ב־IFCDC עודכנו. המשיכו להזמין כדי לפתוח הטבות.",
    loyaltyOpen: "פתחו את IFCDC Barbers",
  },
  "zh-CN": {
    reminderSubject: "提醒 — 约 ~30 分钟后有预约",
    reminderHi: "您好 {{name}}，",
    reminderBody:
      "温馨提醒：您大约在 <strong>{{when}}</strong> 与 <strong>{{barber}}</strong> 有预约（{{service}}）。",
    reminderSeeYou: "期待很快见到您。",
    reminderText: "您好 {{name}}。提醒：预约 ~{{when}}。",
    reviewSubject: "您的预约已完成 — 请评价 {{barber}}",
    reviewTitle: "体验如何？",
    reviewHi: "您好 {{name}}，",
    reviewBody:
      "您的预约已完成。与 <strong>{{barber}}</strong> 的体验如何？点击下方留下评分、评价和照片。",
    reviewCta: "留下评价",
    reviewAppLink: "应用链接：",
    reviewNote: "仅已完成预约的客户可评价 — 每个预约一条评价。",
    refundSubject: "[IFCDC] 退款已处理 — ${{amount}}",
    refundTitle: "退款确认",
    refundName: "姓名",
    refundBarber: "理发师",
    refundService: "服务",
    refundDate: "日期",
    refundTime: "时间",
    refundStatus: "状态",
    refundAmount: "退款金额",
    refundRef: "PayPal 退款参考号",
    refundReason: "原因",
    refundFunds: "款项通常在 3–10 个工作日内退回您的 PayPal 或银行卡。",
    cancelSubject: "预约已取消 — IFCDC Barbers",
    cancelTitle: "预约已取消",
    cancelBody: "您的预约已取消。",
    cancelWhen: "原定时间",
    loyaltySubject: "IFCDC 积分更新",
    loyaltyBody: "您的 IFCDC 忠诚积分已更新。继续预约以解锁奖励。",
    loyaltyOpen: "打开 IFCDC Barbers",
  },
  ko: {
    reminderSubject: "알림 — 약 30분 후 예약",
    reminderHi: "안녕하세요 {{name}}님,",
    reminderBody:
      "알림입니다: <strong>{{when}}</strong>경에 <strong>{{barber}}</strong>님과 예약({{service}})이 있습니다.",
    reminderSeeYou: "곧 뵙겠습니다.",
    reminderText: "안녕하세요 {{name}}님. 알림: 예약 ~{{when}}.",
    reviewSubject: "예약이 완료되었습니다 — {{barber}}님을 평가해 주세요",
    reviewTitle: "이용 경험은 어떠셨나요?",
    reviewHi: "안녕하세요 {{name}}님,",
    reviewBody:
      "예약이 완료되었습니다. <strong>{{barber}}</strong>님과의 경험은 어떠셨나요? 아래에서 별점, 리뷰, 사진을 남겨 주세요.",
    reviewCta: "리뷰 남기기",
    reviewAppLink: "앱 링크:",
    reviewNote: "완료된 예약이 있는 고객만 리뷰를 남길 수 있습니다 — 예약당 1개.",
    refundSubject: "[IFCDC] 환불 처리됨 — ${{amount}}",
    refundTitle: "환불 확인",
    refundName: "이름",
    refundBarber: "바버",
    refundService: "서비스",
    refundDate: "날짜",
    refundTime: "시간",
    refundStatus: "상태",
    refundAmount: "환불 금액",
    refundRef: "PayPal 환불 참조",
    refundReason: "사유",
    refundFunds: "보통 3–10영업일 내에 PayPal 또는 카드로 환불됩니다.",
    cancelSubject: "예약 취소됨 — IFCDC Barbers",
    cancelTitle: "예약 취소됨",
    cancelBody: "예약이 취소되었습니다.",
    cancelWhen: "원래 예정",
    loyaltySubject: "IFCDC 로열티 업데이트",
    loyaltyBody: "IFCDC 로열티 포인트가 업데이트되었습니다. 계속 예약하여 리워드를 잠금 해제하세요.",
    loyaltyOpen: "IFCDC Barbers 열기",
  },
  vi: {
    reminderSubject: "Nhắc nhở — lịch hẹn trong ~30 phút",
    reminderHi: "Xin chào {{name}},",
    reminderBody:
      "Đây là lời nhắc: bạn có lịch hẹn khoảng <strong>{{when}}</strong> với <strong>{{barber}}</strong> ({{service}}).",
    reminderSeeYou: "Hẹn sớm gặp lại.",
    reminderText: "Xin chào {{name}}. Nhắc nhở: lịch hẹn ~{{when}}.",
    reviewSubject: "Lịch hẹn của bạn đã hoàn tất — đánh giá {{barber}}",
    reviewTitle: "Trải nghiệm của bạn thế nào?",
    reviewHi: "Xin chào {{name}},",
    reviewBody:
      "Lịch hẹn của bạn đã hoàn tất. Trải nghiệm với <strong>{{barber}}</strong> thế nào? Nhấn bên dưới để để lại đánh giá, nhận xét và ảnh.",
    reviewCta: "Để lại đánh giá",
    reviewAppLink: "Liên kết ứng dụng:",
    reviewNote: "Chỉ khách đã hoàn tất lịch hẹn mới được đánh giá — một đánh giá mỗi đặt chỗ.",
    refundSubject: "[IFCDC] Đã xử lý hoàn tiền — ${{amount}}",
    refundTitle: "Xác nhận hoàn tiền",
    refundName: "Tên",
    refundBarber: "Thợ cắt tóc",
    refundService: "Dịch vụ",
    refundDate: "Ngày",
    refundTime: "Giờ",
    refundStatus: "Trạng thái",
    refundAmount: "Số tiền hoàn",
    refundRef: "Mã hoàn tiền PayPal",
    refundReason: "Lý do",
    refundFunds: "Tiền thường về PayPal hoặc thẻ trong 3–10 ngày làm việc.",
    cancelSubject: "Lịch hẹn đã hủy — IFCDC Barbers",
    cancelTitle: "Lịch hẹn đã hủy",
    cancelBody: "Lịch hẹn của bạn đã được hủy.",
    cancelWhen: "Ban đầu đã lên lịch",
    loyaltySubject: "Cập nhật điểm thưởng IFCDC",
    loyaltyBody: "Điểm thưởng IFCDC của bạn đã được cập nhật. Tiếp tục đặt lịch để mở khóa phần thưởng.",
    loyaltyOpen: "Mở IFCDC Barbers",
  },
};

function interpolate(template, vars = {}) {
  return String(template || "").replace(/\{\{(\w+)\}\}/g, (_, key) =>
    vars[key] == null ? "" : String(vars[key]),
  );
}

function customerEmailLabels(language) {
  const code = normalizeLang(language);
  const localized = TABLE[code] || {};
  const out = { ...EN, ...localized, _code: code };
  return out;
}

function tLabel(labels, key, vars) {
  const raw = labels?.[key] != null ? labels[key] : EN[key];
  return interpolate(raw == null ? EN[key] || key : raw, vars);
}

module.exports = {
  normalizeLang,
  customerEmailLabels,
  tLabel,
  EN,
};
