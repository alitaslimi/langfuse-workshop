import type { SupportContext } from "../shared/types";

export type GuideArticle = {
  id: string;
  title: string;
  searchableTerms: string[];
  summary: string;
  steps: string[];
  caution?: string;
};

export const DEFAULT_SUPPORT_CONTEXT: SupportContext = {
  id: "dad-default",
  label: "Dad",
  relationship: "Dad's everyday iPhone setup for calls, photos, travel, and small phone tasks.",
  devices: ["iPhone 15"],
  phone: {
    model: "iPhone 15",
    os: "iOS 18.5",
    finish: "Black, 128 GB",
    purchased: "Sep 2023"
  },
  notes: [],
  deviceSummary:
    "Dad mostly uses WhatsApp, Photos, Apple Maps, and Safari on his iPhone. He likes exact button names and calm reassurance before tapping.",
  responseStyle:
    "Talk directly to Dad in second person. Keep the tone calm, practical, and concrete with short numbered steps.",
  notableApps: ["WhatsApp", "Photos", "Apple Maps", "Safari", "Messages"],
  scopeHighlights: [
    "iPhone settings basics",
    "Photos and sharing",
    "Bluetooth and Wi-Fi",
    "Maps basics",
    "Messaging basics",
    "Display, battery and Screen Time settings",
    "iCloud backup"
  ],
  starterQuestions: [
    "How do I turn Bluetooth on on my iPhone?",
    "How do I take a photo and send it on WhatsApp?",
    "How do I reconnect my iPhone to Wi-Fi?",
    // Replaced "How do I find directions to a bus stop in Maps?", which no
    // session asked; dark mode was the top uncovered iOS settings request.
    "How do I turn on dark mode?"
  ]
};

export const GUIDE_LIBRARY: GuideArticle[] = [
  {
    id: "iphone-bluetooth",
    title: "Turn Bluetooth on for Dad's iPhone",
    searchableTerms: ["bluetooth", "airpods", "earbuds", "pair", "headphones", "iphone"],
    summary: "Simple Bluetooth steps for Dad's iPhone.",
    steps: [
      "Open the Settings app.",
      "Tap Bluetooth.",
      "Turn Bluetooth on so the switch shows green.",
      "If you are pairing something new, keep that device in pairing mode and wait for its name to appear."
    ],
    caution: "If Bluetooth is already on, the accessory usually still needs to be put into pairing mode."
  },
  {
    id: "iphone-photo-whatsapp",
    title: "Take a photo and send it in WhatsApp",
    searchableTerms: ["photo", "camera", "whatsapp", "send", "picture", "iphone"],
    summary: "Capture and share a photo from Dad's iPhone.",
    steps: [
      "Open Camera and tap the white shutter button to take the photo.",
      "Open WhatsApp and choose the chat you want.",
      "Tap the plus button, then Photo Library or Camera.",
      "Choose the photo and tap Send."
    ]
  },
  {
    id: "iphone-wifi",
    title: "Reconnect Dad's iPhone to Wi-Fi",
    searchableTerms: ["wifi", "wi-fi", "internet", "network", "router", "iphone"],
    summary: "Reconnect the iPhone to home Wi-Fi.",
    steps: [
      "Open Settings and tap Wi-Fi.",
      "Make sure Wi-Fi is turned on.",
      "Tap the home network name.",
      "Enter the Wi-Fi password carefully, then tap Join."
    ],
    caution: "If the network name is missing, move closer to the router and wait a moment for the list to refresh."
  },
  {
    id: "iphone-maps-bus-stop",
    title: "Find directions to a bus stop in Apple Maps",
    searchableTerms: ["bus", "bus stop", "maps", "directions", "travel", "iphone"],
    summary: "Use Apple Maps for nearby bus directions without pretending to see live location.",
    steps: [
      "Open Maps.",
      "Search for the bus stop name or the nearby street.",
      "Tap Directions.",
      "Choose walking or transit if that option appears on the phone."
    ],
    caution: "The workshop demo can explain the taps, but it cannot see Dad's live location."
  },
  {
    id: "iphone-photo-preview",
    title: "Open the photo you just took on the iPhone",
    searchableTerms: ["photo", "preview", "thumbnail", "open", "iphone", "camera"],
    summary: "Quickly review the photo you just captured.",
    steps: [
      "Stay in the Camera app right after taking the photo.",
      "Tap the small thumbnail in the bottom-left corner.",
      "Swipe left or right to see other recent photos.",
      "Tap Done to return to the camera when you are finished."
    ]
  },
  {
    id: "iphone-messages-send",
    title: "Send a text message from the iPhone",
    searchableTerms: ["message", "messages", "text", "imessage", "send", "iphone"],
    summary: "Send a text from the Messages app.",
    steps: [
      "Open the Messages app.",
      "Tap the new message button in the top-right corner.",
      "Type the contact name or phone number in the To field.",
      "Tap the message area, type the message, then tap the blue send arrow."
    ]
  },
  // Guides below were added from the Data page request insights: iOS &
  // settings and iCloud requests were the most common with no guide at all.
  {
    id: "iphone-dark-mode",
    title: "Turn on Dark Mode on the iPhone",
    searchableTerms: ["dark mode", "dark", "night mode", "black background", "appearance", "light mode"],
    summary: "Switch the iPhone to a dark background, or back to light.",
    steps: [
      "On the Home Screen, open Settings (the grey gear icon).",
      "Scroll down and tap Display & Brightness.",
      "At the top, under Appearance, tap Dark. The screen turns dark straight away.",
      "To switch back, tap Light in the same place."
    ],
    caution: "If Automatic is turned on, the iPhone switches between light and dark by itself at sunset and sunrise."
  },
  {
    id: "iphone-low-power-mode",
    title: "Turn on Low Power Mode to save battery",
    searchableTerms: ["low power", "low power mode", "battery", "save battery", "battery saver", "charge"],
    summary: "Make the battery last longer when it is running low.",
    steps: [
      "On the Home Screen, open Settings (the grey gear icon).",
      "Scroll down and tap Battery.",
      "Turn on the Low Power Mode switch so it shows green.",
      "The battery icon at the top of the screen turns yellow while Low Power Mode is on."
    ],
    caution: "Low Power Mode turns itself off once the iPhone is charged above 80%."
  },
  {
    id: "iphone-brightness",
    title: "Make the iPhone screen brighter or dimmer",
    searchableTerms: ["brightness", "brighter", "dimmer", "screen too dark", "screen light", "display"],
    summary: "Change how bright the screen is.",
    steps: [
      "Swipe down from the top-right corner of the screen to open Control Center.",
      "Find the tall slider with the sun symbol.",
      "Drag it up to make the screen brighter, or down to make it dimmer.",
      "Swipe up or tap an empty area to close Control Center."
    ],
    caution: "You can also change it in Settings, Display & Brightness, using the slider at the top."
  },
  {
    id: "iphone-screen-time-limit",
    title: "Set a daily time limit for an app",
    searchableTerms: ["screen time", "time limit", "app limit", "limit", "too much time", "usage"],
    summary: "Use Screen Time to limit how long an app can be used each day.",
    steps: [
      "On the Home Screen, open Settings (the grey gear icon).",
      "Tap Screen Time. If it is off, tap Turn On Screen Time first.",
      "Tap App Limits, then Add Limit.",
      "Choose the app or category, tap Next, set the time, then tap Add."
    ]
  },
  {
    id: "iphone-icloud-backup",
    title: "Back up the iPhone to iCloud",
    searchableTerms: ["backup", "back up", "icloud", "icloud backup", "save my phone", "restore"],
    summary: "Make a copy of the iPhone in iCloud so nothing is lost.",
    steps: [
      "Connect the iPhone to Wi-Fi.",
      "On the Home Screen, open Settings (the grey gear icon) and tap your name at the top.",
      "Tap iCloud, then iCloud Backup.",
      "Turn on Back Up This iPhone, then tap Back Up Now and wait until it finishes."
    ],
    caution: "Backing up needs enough free iCloud storage. If there is not enough, the iPhone shows a message saying so."
  }
];

export function searchGuides(question: string) {
  const normalizedQuestion = question.toLowerCase();
  const terms = normalizedQuestion.split(/[^a-z0-9]+/).filter(Boolean);

  return GUIDE_LIBRARY.map((guide) => {
    const guideText = `${guide.title} ${guide.summary} ${guide.searchableTerms.join(" ")}`.toLowerCase();
    const score = terms.reduce((total, term) => {
      return total + (guideText.includes(term) ? 1 : 0);
    }, 0);

    return { guide, score };
  })
    .filter(({ score }) => score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, 3)
    .map(({ guide }) => guide);
}
