/**
 * IFCDC Barbers — legal & compliance content.
 *
 * Custom-written for the IFCDC multi-shop SaaS ecosystem. Each document is
 * versioned via `effective`; bump `policyVersion` whenever material content
 * changes so the backend can re-prompt for acceptance on next launch.
 *
 * NOTE: This file deliberately avoids:
 *  - Naming third-party law firms or counsel.
 *  - Promising payment methods that are not live (Apple Pay, SMS, etc.).
 *  - Referencing infrastructure providers beyond what we actually use today.
 *
 * Active providers referenced: PayPal (payments), Resend (transactional email),
 * Expo (push notification delivery). Twilio SMS is currently suspended.
 * AURA is text-only and described accordingly.
 */

export type LegalDocKey =
  | "privacy"
  | "terms"
  | "cancellation"
  | "platformFee"
  | "aura"
  | "barberTerms"
  | "notifications"
  | "security";

export type LegalSection = {
  heading?: string;
  body: string | string[];
};

export type LegalDocument = {
  key: LegalDocKey;
  title: string;
  shortTitle: string;
  summary: string;
  effective: string; // ISO date YYYY-MM-DD
  sections: LegalSection[];
};

/**
 * Bump this when ANY document changes substantively. The mobile app will
 * re-record acceptance under the new version on the next launch flow.
 */
export const POLICY_VERSION = "2026-05-25";

const PLATFORM = "IFCDC Barbers";
const SUPPORT_EMAIL = "support@ifcdcbarbersapp.com";
const PLATFORM_FEE = "$0.99";

export const LEGAL_DOCUMENTS: Record<LegalDocKey, LegalDocument> = {
  privacy: {
    key: "privacy",
    title: "Privacy Policy",
    shortTitle: "Privacy",
    summary:
      "What we collect, why we collect it, how it's protected, and what we never do with it.",
    effective: POLICY_VERSION,
    sections: [
      {
        heading: "About this policy",
        body: `${PLATFORM} is a multi-tenant booking platform serving customers, barbers, shop owners, and platform administrators. This Privacy Policy explains the data practices that apply when you use the ${PLATFORM} mobile app or the related web services. It covers everyone who interacts with the platform regardless of role.`,
      },
      {
        heading: "Information we collect",
        body: [
          "Account information you provide: full name, email address, password (stored only as a salted hash), account role (customer, barber, shop owner), and optional profile photo.",
          "Booking information: barber, shop, service selected, scheduled date and time, duration, status, customer-facing notes, and any reschedule or cancellation history.",
          "Payment references: PayPal order and capture identifiers and the resulting payment status. We do not store full card numbers, CVCs, or bank credentials. Payment processing is performed by PayPal under their own terms.",
          "Communication metadata: confirmation emails sent through Resend, push delivery receipts from Expo, and device-level push tokens you choose to register.",
          "Device data: app version, operating system family (iOS or Android), preferred language, and notification permission state.",
          "AI interactions: messages you send to AURA, the platform's text assistant, and the assistant's replies. AURA is text-only.",
          "Security and audit metadata: sign-in events, role-change events, and tenant-scoped administrative actions used to keep accounts safe.",
        ],
      },
      {
        heading: "How we use your information",
        body: [
          "To create and operate your account, including showing you the right tools for your role.",
          "To run the booking lifecycle end-to-end: confirmations, reminders, status changes, reschedules, cancellations, and refunds.",
          "To process payments through PayPal and to display receipts and balances inside the app.",
          "To send transactional notifications you've opted into and to remember your notification preferences across devices.",
          "To improve product quality through aggregate analytics, error monitoring, and AI quality review.",
          "To detect, investigate, and respond to fraud, abuse, and security incidents.",
        ],
      },
      {
        heading: "How we share your information",
        body: [
          `Within your tenant: your booking details are visible to the barber, shop owner, and platform administrators responsible for fulfilling and supporting your appointment. Other customers cannot see your bookings.`,
          "Service providers we rely on today: PayPal for payment processing, Resend for transactional email, and Expo for push delivery. Each provider receives only the minimum information required to perform its task.",
          "Legal and safety reasons: we may share information when required by law, when responding to valid legal process, or when needed to protect the rights, property, or safety of our users or the platform.",
          `We do not sell your personal information, and we do not rent your contact list to third parties. ${PLATFORM} does not run third-party ad networks.`,
          "Mobile phone numbers, SMS consent records, and messaging opt-in information are not sold, rented, or shared with third parties or affiliates for marketing or promotional purposes.",
        ],
      },
      {
        heading: "How your information is protected",
        body: [
          "Passwords are stored as one-way salted hashes. Plain-text passwords are never stored or logged.",
          "Network traffic between the app and our servers is encrypted in transit using TLS.",
          "Access to production data is scoped by role. Customers can see only their own records; barbers see their own bookings; shop owners see their shop; platform administrators have audited override access.",
          "Critical actions (account creation, role change, payment events) are recorded in security audit logs.",
        ],
      },
      {
        heading: "Your choices",
        body: [
          "You can edit your profile, change your password, and adjust notification preferences at any time inside the app.",
          "You can request export or deletion of your account by emailing the support address below. Some records (financial transactions, security logs) may be retained for the period required by applicable law.",
          "You can disable push notifications from the device's system settings or from the in-app Notifications screen.",
        ],
      },
      {
        heading: "Children",
        body: `${PLATFORM} is not directed to children under 13. We do not knowingly collect personal information from children under 13. If you believe a child under 13 has provided personal information, please contact ${SUPPORT_EMAIL} so we can investigate and remove it.`,
      },
      {
        heading: "Changes to this policy",
        body: "We may update this policy from time to time. When we make material changes we will update the effective date at the top of this document and prompt you to acknowledge the new version on next launch. Continued use of the app after a material update means you accept the updated policy.",
      },
      {
        heading: "Contact",
        body: `Questions about privacy can be sent to ${SUPPORT_EMAIL}.`,
      },
    ],
  },

  terms: {
    key: "terms",
    title: "Terms & Conditions",
    shortTitle: "Terms",
    summary:
      "The agreement that governs your use of the IFCDC Barbers app and platform services.",
    effective: POLICY_VERSION,
    sections: [
      {
        heading: "Acceptance of terms",
        body: `By creating an account or using ${PLATFORM} you agree to these Terms & Conditions. If you do not agree, do not create an account or use the service. These terms apply to customers, barbers, shop owners, and platform administrators.`,
      },
      {
        heading: "Eligibility",
        body: [
          "You must be at least 13 years old to create a customer account, and you must have a parent or legal guardian's permission if you are under the age of majority where you live.",
          "Barbers and shop owners must be at least 18 years old and must comply with all applicable local licensing, registration, and health-and-safety requirements that apply to their trade.",
          "You agree to provide accurate registration information and to keep it current.",
        ],
      },
      {
        heading: "Your account",
        body: [
          "You are responsible for activity that occurs under your account.",
          "Keep your password private. Never share it with anyone, including staff.",
          "If you believe your account has been used without your permission, change your password and email " +
            SUPPORT_EMAIL +
            " right away.",
        ],
      },
      {
        heading: "Booking responsibilities",
        body: [
          "When you book an appointment you agree to arrive on time at the address listed for the shop or barber, ready for your scheduled service.",
          "When you book or modify an appointment you authorize the platform to take the actions needed to fulfill the booking, including charging the platform fee through PayPal.",
          "If you cannot attend, cancel or reschedule through the app as soon as possible. Repeated no-shows may lead to suspension or restrictions on future bookings.",
        ],
      },
      {
        heading: "Barber and shop responsibilities",
        body: [
          "Barbers and shop owners are independent professionals or businesses; they are not employees of the platform.",
          "Barbers set the prices for their own services through the in-app menu, subject to oversight by the shop owner and the platform.",
          "Barbers and shop owners agree to comply with applicable law, including consumer-protection, anti-discrimination, health-and-safety, and tax obligations that apply to their work.",
          "All service prices, durations, and modifications are recorded in the platform's audit log.",
        ],
      },
      {
        heading: "Acceptable use",
        body: [
          "Do not use the platform to harass, threaten, defraud, defame, or harm any other user.",
          "Do not impersonate another person or misrepresent your role on the platform.",
          "Do not attempt to bypass security, scrape data, reverse engineer, or interfere with the platform's normal operation.",
          "Do not upload illegal content, malware, or material that violates intellectual property rights.",
        ],
      },
      {
        heading: "Payments",
        body: [
          "Payments are processed by PayPal. By confirming a payment you accept PayPal's terms in addition to these.",
          `A non-refundable platform fee of ${PLATFORM_FEE} is charged on top of the service price for each paid booking. Full details are in the Platform Fee Disclosure document.`,
          "Refund requests are reviewed by the shop based on the Cancellation & Refund Policy. Approved refunds are returned through PayPal and may take several business days to settle.",
        ],
      },
      {
        heading: "Suspension and termination",
        body: [
          "We may suspend or terminate accounts that violate these terms, abuse other users, or pose a security or financial risk to the platform.",
          "You can stop using the platform and request account deletion at any time by emailing " + SUPPORT_EMAIL + ".",
        ],
      },
      {
        heading: "Disclaimers",
        body: [
          'The platform is provided on an "as is" and "as available" basis. We do not guarantee that the service will be uninterrupted, secure against every possible attack, or error-free.',
          "Service results (haircuts, styles, recommendations) are the responsibility of the individual barber or shop, not the platform.",
        ],
      },
      {
        heading: "Limitation of liability",
        body: "To the fullest extent allowed by law, the platform is not liable for indirect, incidental, special, consequential, or punitive damages, or any loss of profits, revenue, data, or goodwill arising out of your use of the platform. Nothing in these terms limits liability that cannot be limited under applicable law.",
      },
      {
        heading: "Governing law",
        body: "These terms are governed by the laws applicable in your jurisdiction of residence, except as otherwise required by mandatory consumer-protection law.",
      },
      {
        heading: "Changes to terms",
        body: "We may revise these terms from time to time. We will update the effective date at the top of this document and require renewed acceptance on next launch when changes are material.",
      },
    ],
  },

  cancellation: {
    key: "cancellation",
    title: "Cancellation & Refund Policy",
    shortTitle: "Cancellation",
    summary:
      "How cancellations, no-shows, reschedules, and refund reviews work on the platform.",
    effective: POLICY_VERSION,
    sections: [
      {
        heading: "Customer cancellations",
        body: [
          "Customers can cancel an upcoming appointment from the booking detail screen. The slot is released immediately so other customers can book it, unless an administrator chooses to keep it on hold.",
          "Cancelling does not automatically issue a refund. The shop reviews each request based on the policies below and the current payment status.",
          "When you cancel, you can include an optional reason. The reason is recorded in the booking history and shared with the shop.",
        ],
      },
      {
        heading: "Reschedules",
        body: [
          "Customers can reschedule with the same barber to any available slot in the next two weeks. The system prevents double-booking and verifies the new slot in real time.",
          "After rescheduling, the booking returns to a confirmed state, the old slot is released, and the platform sends a refreshed confirmation email when email is enabled.",
          "Barbers and shop owners can also reschedule appointments assigned to them, subject to their role permissions.",
        ],
      },
      {
        heading: "No-shows",
        body: [
          "If a customer does not arrive for a scheduled appointment, the barber or shop owner may mark the booking as a no-show. This is recorded in the booking history.",
          "Repeated no-shows may lead to restrictions on future bookings.",
        ],
      },
      {
        heading: "Refund review",
        body: [
          "Refunds are not automatic. When you request one, the shop reviews the booking, the cancellation timing, the payment status, and any applicable shop policy.",
          "Approved refunds are processed through PayPal. Settlement typically takes between three and ten business days depending on your bank or card issuer.",
          `The ${PLATFORM_FEE} platform fee is non-refundable when the booking was fulfilled. When the entire booking is refunded by the shop, the platform fee is also returned.`,
          "If you have not received an expected refund within ten business days of approval, contact " +
            SUPPORT_EMAIL +
            " with your booking ID for help.",
        ],
      },
      {
        heading: "Shop and barber cancellations",
        body: [
          "Barbers and shop owners may cancel a booking when they are unable to fulfill it. When they do, the slot is released and the customer is notified through the channels they have enabled.",
          "When a shop cancels a fully-paid booking, a refund is normally offered subject to PayPal settlement.",
        ],
      },
      {
        heading: "Disputes",
        body:
          "If something goes wrong, please contact the shop first through the booking detail screen. If the issue is not resolved, email " +
          SUPPORT_EMAIL +
          " with the booking ID and a brief description and we will investigate.",
      },
    ],
  },

  platformFee: {
    key: "platformFee",
    title: "Platform Fee Disclosure",
    shortTitle: "Platform fee",
    summary:
      "What the IFCDC platform fee is, why it exists, and how it is charged.",
    effective: POLICY_VERSION,
    sections: [
      {
        heading: "What the platform fee is",
        body: `The platform fee is a small charge of ${PLATFORM_FEE} added on top of the barber's service price for each paid booking made through ${PLATFORM}. It is shown to you on the booking summary screen before you confirm payment.`,
      },
      {
        heading: "How it is calculated and charged",
        body: [
          `Service price: set by the barber for the service you select.`,
          `Platform fee: a flat ${PLATFORM_FEE} per booking, regardless of service length or price.`,
          `Total charged through PayPal: service price (or applicable deposit) plus the platform fee.`,
          `The fee is captured at the same time as the booking payment. No separate transaction is required.`,
        ],
      },
      {
        heading: "What the platform fee supports",
        body: [
          "Hosting and operating the booking, payment, and notification infrastructure.",
          "Payment processing and reconciliation work for the shop's payouts.",
          "Customer and shop support during business hours.",
          "Ongoing development of new features such as smarter scheduling, AURA assistance, and shop analytics.",
        ],
      },
      {
        heading: "Refundability",
        body: [
          "When a booking is fulfilled, the platform fee is non-refundable.",
          "When a shop refunds a booking in full, the platform fee is returned together with the service price.",
          "Partial refunds (for example, refunding a deposit only) are reviewed case-by-case and disclosed in the booking history.",
        ],
      },
      {
        heading: "Future changes",
        body:
          "If the platform fee changes, the new amount will be displayed on the booking summary screen before you confirm any future payment, and this disclosure document will be updated with a new effective date.",
      },
    ],
  },

  aura: {
    key: "aura",
    title: "AI / AURA Disclosure",
    shortTitle: "AURA",
    summary:
      "How the AURA assistant works, what it should and should not be used for, and how conversations are handled.",
    effective: POLICY_VERSION,
    sections: [
      {
        heading: "What AURA is",
        body: [
          `AURA is the in-app text assistant for ${PLATFORM}. It is a chat-based helper that can answer questions about bookings, services, schedules, and platform features.`,
          "AURA is text-only. It cannot make phone calls, send SMS, or take actions on your behalf without your explicit confirmation.",
        ],
      },
      {
        heading: "What AURA is not",
        body: [
          "AURA is not a doctor, lawyer, financial advisor, accountant, or licensed professional of any kind. Do not rely on it for medical, legal, financial, or other professional advice.",
          "AURA is not an emergency service. If you are experiencing a medical, safety, or other emergency, contact your local emergency services immediately.",
          "AURA is not a replacement for human support. For account, payment, or safety issues you can always reach a person at " +
            SUPPORT_EMAIL +
            ".",
        ],
      },
      {
        heading: "Accuracy and limitations",
        body: [
          "AURA generates responses using language-model technology and may produce information that is incorrect, out of date, or incomplete. Always confirm important details (such as appointment times or pricing) directly inside the booking flow before acting on them.",
          "AURA does not have access to data outside the platform unless we say otherwise. It cannot read your private device data, payment cards, or third-party accounts.",
        ],
      },
      {
        heading: "How conversations are handled",
        body: [
          "AURA messages may be reviewed by a small number of authorized staff for quality, safety, and product-improvement purposes.",
          "Where feasible we minimize personally identifying details in those reviews.",
          "AURA does not use your conversation contents to train or fine-tune models for unrelated third-party services.",
        ],
      },
      {
        heading: "Your choice",
        body:
          "Using AURA is optional. You can use the rest of the app without sending it any messages. If you choose not to use AURA, no notifications, bookings, or payments are affected.",
      },
    ],
  },

  barberTerms: {
    key: "barberTerms",
    title: "Barber & Shop Owner Terms",
    shortTitle: "Pro terms",
    summary:
      "Additional terms that apply to barbers and shop owners using IFCDC Barbers as a workplace platform.",
    effective: POLICY_VERSION,
    sections: [
      {
        heading: "Independent professional",
        body: [
          `By using ${PLATFORM} as a barber or shop owner you agree that you are an independent professional or business, not an employee of the platform.`,
          "You are responsible for your own licensing, certifications, registrations, taxes, and insurance, where required by your local jurisdiction.",
        ],
      },
      {
        heading: "Tenant scope",
        body: [
          "Barbers can see and act on bookings assigned to them.",
          "Shop owners can see and act on bookings, services, and staff inside the shop they own.",
          "Platform administrators can see all tenants and may act in support, security, or compliance situations. Every administrative override is recorded in the audit log.",
        ],
      },
      {
        heading: "Service menu and pricing authority",
        body: [
          "Barbers control the service menu and prices for their own bookings. The platform server is the source of truth for prices: prices submitted by the client app are validated against the database before any booking is confirmed.",
          "Every change to a service (creation, price change, deactivation, deletion) is logged with the actor, role, before/after values, and timestamp. Logs are kept for the period required for fraud prevention and dispute resolution.",
          "Shop owners can review and override service entries inside their shop. Platform administrators can intervene in cases of policy violation.",
        ],
      },
      {
        heading: "Payouts and fees",
        body: [
          "Customer payments are processed through PayPal. Net of the platform fee and applicable PayPal charges, the remainder belongs to the barber or shop in line with shop policy.",
          `The platform fee of ${PLATFORM_FEE} per paid booking is described in the Platform Fee Disclosure.`,
          "Payout cadence and reconciliation are handled inside the shop's PayPal account. The platform does not hold barber or shop funds for extended periods.",
        ],
      },
      {
        heading: "Conduct standards",
        body: [
          "No discrimination based on race, color, national origin, religion, sex, gender identity, sexual orientation, age, disability, or any other protected category under applicable law.",
          "No misrepresentation of services, qualifications, or pricing.",
          "Maintain professional behavior, including health and safety standards in your work environment.",
        ],
      },
      {
        heading: "Termination",
        body:
          "We may suspend or terminate barber or shop access for serious or repeated breaches of these terms, fraud, harm to customers, or violation of applicable law. We will give notice when feasible. Outstanding payouts owed under correctly fulfilled bookings will still be processed.",
      },
    ],
  },

  notifications: {
    key: "notifications",
    title: "Notification & Messaging Consent",
    shortTitle: "Notifications",
    summary:
      "How notifications work today, what you can opt into, and how future channels (such as SMS) will be handled.",
    effective: POLICY_VERSION,
    sections: [
      {
        heading: "Channels active today",
        body: [
          "Push notifications, delivered through Expo to your iOS or Android device.",
          "Transactional email, sent through Resend for confirmations and reminders.",
        ],
      },
      {
        heading: "Categories you can control",
        body: [
          "Booking confirmations, sent when a new appointment is confirmed.",
          "Appointment reminders, sent before a scheduled appointment.",
          "Cancellations, when an appointment is cancelled.",
          "Reschedules, when an appointment moves to a new time.",
          "Appointment status updates, including check-in, completion, and no-show events.",
          "Admin and platform alerts, for staff and shop owners.",
          "Marketing and promotions, which are off by default and sent only if you opt in.",
        ],
      },
      {
        heading: "How to manage notifications",
        body: [
          "Open the Notifications screen inside your profile to turn channels and categories on or off.",
          "Use your device's system settings to revoke push permission at any time.",
          "Email channels can be disabled inside the in-app preferences.",
        ],
      },
      {
        heading: "SMS",
        body: [
          "Optional customer-care and appointment SMS may be offered by IFCDC Barbers App, operated by Imperial Foundation Community Development Center (IFCDC).",
          "SMS consent is separate from Terms and Privacy acceptance, is unchecked by default, and is never required to register, book, or purchase.",
          "Mobile phone numbers, SMS consent records, and messaging opt-in information are not sold, rented, or shared with third parties or affiliates for marketing or promotional purposes.",
          "Reply STOP to opt out or HELP for help. Message frequency varies. Message and data rates may apply.",
          "Public consent page: https://ifcdcbarbersapp.com/sms-consent",
          "SMS will never be enabled by default and will not be used for marketing without explicit, separate consent.",
        ],
      },
      {
        heading: "Future Apple Pay and additional channels",
        body:
          "If new payment methods (such as Apple Pay) or new notification channels become available, we will disclose them in-app and update this document with a new effective date before activating them.",
      },
    ],
  },

  security: {
    key: "security",
    title: "Data & Account Security Notice",
    shortTitle: "Security",
    summary:
      "How we protect your account, what we expect from you, and what to do if something goes wrong.",
    effective: POLICY_VERSION,
    sections: [
      {
        heading: "Your responsibilities",
        body: [
          "Use a strong password. The platform requires at least 12 characters and a mix of upper-case, lower-case, numeric, and symbolic characters.",
          "Never share your password with another person, including staff. We will never ask you for your password.",
          "Keep the email on your account up to date so we can reach you about security issues.",
          "Sign out from devices you no longer use. You can do this from the Profile screen.",
        ],
      },
      {
        heading: "Platform protections",
        body: [
          "Passwords are stored as one-way salted hashes; we cannot recover the plain-text password and we never display it.",
          "Authenticated requests use signed JSON Web Tokens with a short lifetime. Tokens are revocable when an account is suspended or its role changes.",
          "Network traffic between the app and our servers is protected with TLS.",
          "Access to administrative tools is gated by role and tenant. Sensitive actions (role changes, refunds, override status changes) are recorded in the security audit log.",
        ],
      },
      {
        heading: "Reporting suspicious activity",
        body: [
          "If you receive a confirmation email, push notification, or login alert that you do not recognize, change your password right away from the in-app Profile screen.",
          "Email " +
            SUPPORT_EMAIL +
            " with the date, time, and any details you remember. Include a screenshot when possible.",
          "If you believe payment fraud has occurred, also contact PayPal directly to dispute the charge.",
        ],
      },
      {
        heading: "Incident response",
        body:
          "If we detect a security incident that affects your account, we will contact you using the email on file and provide guidance on next steps as soon as possible. When required by applicable law, we will notify the appropriate regulators within the required timeframe.",
      },
      {
        heading: "Data retention",
        body:
          "We retain account, booking, and audit data for as long as needed to operate the service, satisfy legal and tax obligations, and resolve disputes. You may request deletion at " +
          SUPPORT_EMAIL +
          " subject to those legal obligations.",
      },
    ],
  },
};

/**
 * Order used by the index screen and the menu link in Profile.
 */
export const LEGAL_DOC_ORDER: LegalDocKey[] = [
  "privacy",
  "terms",
  "cancellation",
  "platformFee",
  "aura",
  "barberTerms",
  "notifications",
  "security",
];
