import { FirebaseApp, getApp, getApps, initializeApp } from "firebase/app";
import { Auth, getAuth, signInAnonymously } from "firebase/auth";
import {
  Firestore,
  getFirestore,
  initializeFirestore,
  persistentLocalCache,
  persistentMultipleTabManager,
} from "firebase/firestore";

const firebaseConfig = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
};

const hasFirebaseConfig = Object.values(firebaseConfig).every((value) => Boolean(value));

let app: FirebaseApp | null = null;
let db: Firestore | null = null;
let auth: Auth | null = null;

if (hasFirebaseConfig) {
  app = getApps().length ? getApp() : initializeApp(firebaseConfig);
  auth = getAuth(app);
  if (typeof window !== "undefined") {
    try {
      db = initializeFirestore(app, {
        localCache: persistentLocalCache({
          tabManager: persistentMultipleTabManager(),
        }),
      });
    } catch {
      db = getFirestore(app);
    }
  } else {
    db = getFirestore(app);
  }
}

async function ensureClientAuth(): Promise<void> {
  if (!auth) {
    return;
  }

  if (auth.currentUser) {
    return;
  }

  await signInAnonymously(auth);
}

export { db, hasFirebaseConfig, ensureClientAuth };
