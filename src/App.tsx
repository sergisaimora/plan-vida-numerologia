// @ts-nocheck
/**
 * Converted to TypeScript React (.tsx) automatically.
 * Tip: Remove '@ts-nocheck' and add types gradually when ready.
 */
import React, { createContext, memo, useCallback, useContext, useEffect, useId, useMemo, useRef, useState, Suspense } from 'react';
import { initializeApp, getApps, getApp } from 'firebase/app';
import { getAuth, signInAnonymously, onAuthStateChanged } from 'firebase/auth';
import { addDoc, collection, deleteDoc, doc, getFirestore, limit, onSnapshot, query, serverTimestamp, setLogLevel, getDoc } from 'firebase/firestore';
import { initializeFirestore, persistentLocalCache, persistentSingleTabManager } from 'firebase/firestore';

// ---- REST fallback for 'client is offline' / 'unavailable' cases ----
async function __fetchDocViaREST(app: any, projectId: string, databaseId: string, docPath: string) {
  try {
    const auth = getAuth(app);
    const token = await auth.currentUser?.getIdToken(/* forceRefresh */ true);
    const dbSegment = encodeURIComponent(databaseId || '(default)');
    const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/${dbSegment}/documents/${docPath}`;
    const res = await fetch(url, {
      headers: token ? { 'Authorization': `Bearer ${token}` } : { 'X-Goog-Api-Key': firebaseConfig.apiKey }
    });
    if (!res.ok) return null;
    const json = await res.json();
    if (!json || !json.fields) return null;
    return __fromFirestoreREST(json.fields);
  } catch (e) {
    console.warn('[REST Fallback] fetch error', e);
    return null;
  }
}

// Convert Firestore REST {fields} to plain JS recursively
function __fromFirestoreREST(fields: any): any {
  const parseValue = (v: any): any => {
    if (v === null || v === undefined) return null;
    if ('stringValue' in v) return v.stringValue;
    if ('integerValue' in v) return Number(v.integerValue);
    if ('doubleValue' in v) return Number(v.doubleValue);
    if ('booleanValue' in v) return !!v.booleanValue;
    if ('timestampValue' in v) return v.timestampValue;
    if ('mapValue' in v) {
      const m = v.mapValue?.fields || {};
      const out: any = {};
      for (const k in m) out[k] = parseValue(m[k]);
      return out;
    }
    if ('arrayValue' in v) {
      const arr = v.arrayValue?.values || [];
      return arr.map(parseValue);
    }
    if ('nullValue' in v) return null;
    if ('referenceValue' in v) return v.referenceValue;
    if ('bytesValue' in v) return v.bytesValue;
    if ('geoPointValue' in v) return v.geoPointValue;
    return v;
  };
  const out: any = {};
  for (const key in fields) out[key] = parseValue(fields[key]);
  return out;
}


// =================================================================================
// === CONFIGURACIÓN Y CONSTANTES GLOBALES =========================================
// =================================================================================

const APP_CONFIG = {
    // La clave API será inyectada por el entorno de ejecución de forma segura.
    GEMINI_PROXY_URL: "https://europe-west1-gold-subset-467605-u7.cloudfunctions.net/geminiProxy",
    GEMINI_API_URL: "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-05-20:generateContent",
    CLOUD_FUNCTION_URL: "https://us-central1-gold-subset-467605-u7.cloudfunctions.net/textToSpeechProxy",
    DEFAULT_APP_ID: 'default-app-id',
    MAX_NAME_LENGTH: 100,
    MAX_SAVED_PLANS: 50,
    FETCH_TIMEOUT_MS: 60000,
};
// === Firebase Config (usamos la configuración proporcionada) ======================
const firebaseConfig = {
  apiKey: "AIzaSyATAubIRVbCk1z03eigHsnLoWCcHW861Dw",
  authDomain: "gold-subset-467605-u7.firebaseapp.com",
  projectId: "gold-subset-467605-u7",
  storageBucket: "gold-subset-467605-u7.appspot.com",
  messagingSenderId: "898264190170",
  appId: "1:898264190170:web:0e21a959bc8609658029e3"
};

// Use named Firestore database instead of default
const FIRESTORE_DB_ID = 'analisistextos';


/** Firestore initializer with robust transport for restricted networks. */
function __getDb(app: any, databaseId?: string) {
  try {
    const db = databaseId
      ? initializeFirestore(app, {
          experimentalForceLongPolling: true,
          useFetchStreams: false,
        }, databaseId)
      : initializeFirestore(app, {
          experimentalForceLongPolling: true,
          useFetchStreams: false,
        });
    return db;
  } catch (e) {
    // initializeFirestore throws if called twice for same app+db; fallback to getFirestore
    return databaseId ? getFirestore(app, databaseId) : getFirestore(app);
  }
}

// Para mantener compatibilidad con el código existente que esperaba __firebase_config:
if (typeof globalThis !== 'undefined') {
  try { globalThis.__firebase_config = JSON.stringify(firebaseConfig); } catch {}
}


Object.freeze(APP_CONFIG);

const LANGUAGE_VOICE_MAP = {
    'Español (original)': { lang: 'es-ES', name: 'es-ES-Wavenet-B' },
    'English (USA)': { lang: 'en-US', name: 'en-US-Standard-C' },
    'Français': { lang: 'fr-FR', name: 'fr-FR-Wavenet-B' },
    'Italiano': { lang: 'it-IT', name: 'it-IT-Wavenet-B' },
    'Português': { lang: 'pt-BR', name: 'pt-BR-Wavenet-B' },
    'Deutsch': { lang: 'de-DE', name: 'de-DE-Wavenet-B' },
    'Català': { lang: 'ca-ES', name: 'ca-es-Standard-A' },
    'Lietuvių': { lang: 'lt-LT', name: 'lt-LT-Standard-A' },
};

Object.freeze(LANGUAGE_VOICE_MAP);


// Pequeño helper para fetch con timeout y cancelación
const fetchWithTimeout = (url, options = {}, timeout = APP_CONFIG.FETCH_TIMEOUT_MS) => {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeout);
    const opts = { ...options, signal: controller.signal };
    return fetch(url, opts).finally(() => clearTimeout(id));
};
class GeminiRateLimiter {
    constructor() {
        this.lastRequest = 0;
        this.requestCount = 0;
        this.resetTime = Date.now() + 60000; // Reset cada minuto
    }

    async waitIfNeeded() {
        const now = Date.now();
        
        // Reset counter cada minuto
        if (now > this.resetTime) {
            this.requestCount = 0;
            this.resetTime = now + 60000;
        }

        // Límite de 60 requests por minuto para Gemini
        if (this.requestCount >= 60) {
            const waitTime = this.resetTime - now;
            console.log(`Rate limit alcanzado, esperando ${waitTime}ms`);
            await new Promise(resolve => setTimeout(resolve, waitTime));
            this.requestCount = 0;
            this.resetTime = Date.now() + 60000;
        }

        // Mínimo 1 segundo entre requests
        const timeSinceLastRequest = now - this.lastRequest;
        if (timeSinceLastRequest < 1000) {
            await new Promise(resolve => setTimeout(resolve, 1000 - timeSinceLastRequest));
        }

        this.lastRequest = Date.now();
        this.requestCount++;
    }
}

const rateLimiter = new GeminiRateLimiter();

const callGeminiWithBackoff = async (payload, maxRetries = 3) => {
    await rateLimiter.waitIfNeeded();
    
    for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
            const response = await fetchWithTimeout(APP_CONFIG.GEMINI_PROXY_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });

            if (response.status === 503) {
                throw new Error(`503: Service unavailable`);
            }

            if (!response.ok) {
                const errorBody = await response.text();
                throw new Error(`Error en la API con estado ${response.status}: ${errorBody}`);
            }

            return await response.json();
            
        } catch (error) {
            if (error.message.includes('503') && attempt < maxRetries - 1) {
                const delay = Math.pow(2, attempt) * 1000 + Math.random() * 1000; // 1-2s, 2-4s, 4-8s
                console.log(`Gemini sobrecargado, reintentando en ${delay}ms... (intento ${attempt + 1}/${maxRetries})`);
                await new Promise(resolve => setTimeout(resolve, delay));
            } else {
                throw error;
            }
        }
    }
};

const REGEX = {
    spaceBeforePunct: /\s+([,.;:!?¡¿])/g,
    ensureSpaceAfter: /([,.;:!?])(?=\S)/g,
    capAfterEnd: /(^|[.!?]\s+)([a-záéíóúñ])/g,
    capAfterInverted: /([¿¡]\s*)([a-záéíóúñ])/g,
    dblSpaces: /\s{2,}/g,
    nbsp: /\u00A0/g,
    ellipsisFix1: /(\S)\s*\.\s*\.(\s|$)/g,
    ellipsisFix2: /(?<!\.)\.{4,}/g,
    tePronoun: /\bte(?=\s|[,.;:!?])/gi,
};

// =================================================================================
// === COMPONENTES DE ICONOS (SVG) =================================================
// =================================================================================
// Componentes puros y ligeros para los iconos, evitando dependencias externas.

const IconPlus = memo(() => <svg aria-hidden="true" focusable="false" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></svg>);
const IconTrash = memo(() => <svg aria-hidden="true" focusable="false" xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 5 6 21 6" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /></svg>);
const IconCalculator = memo(() => <svg aria-hidden="true" focusable="false" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="4" y="2" width="16" height="20" rx="2" ry="2" /><line x1="8" y1="6" x2="16" y2="6" /><line x1="16" y1="10" x2="16" y2="18" /><line x1="8" y1="10" x2="8" y2="14" /><line x1="12" y1="10" x2="12" y2="18" /><line x1="8" y1="18" x2="12" y2="18" /></svg>);
const IconPDF = memo(() => <svg aria-hidden="true" focusable="false" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" /><line x1="16" y1="13" x2="8" y2="13" /><line x1="16" y1="17" x2="8" y2="17" /><polyline points="10 9 9 9 8 9" /></svg>);
const IconAlertTriangle = memo(() => <svg aria-hidden="true" focusable="false" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-5 w-5 text-yellow-500"><path d="m21.73 18-8-14a2 2 0 0 0-3.46 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z" /><line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" /></svg>);
const IconSparkles = memo(() => <svg aria-hidden="true" focusable="false" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2L14.5 9.5L22 12L14.5 14.5L12 22L9.5 14.5L2 12L9.5 9.5L12 2Z" /><path d="M22 2L20 6" /><path d="M2 22L6 20" /><path d="M2 2L6 4" /><path d="M22 22L20 18" /></svg>);
const IconChevronDown = memo(() => <svg aria-hidden="true" focusable="false" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 12 15 18 9" /></svg>);
const IconSoundWave = memo(() => <svg aria-hidden="true" focusable="false" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M2 10v4" /><path d="M6 7v10" /><path d="M10 4v16" /><path d="M14 7v10" /><path d="M18 10v4" /></svg>);
const IconDownload = memo(() => <svg aria-hidden="true" focusable="false" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" /></svg>);

// =================================================================================
// === MÓDULO DE DATOS: Textos de Análisis (Carga diferida) ========================
// =================================================================================

// --- DATOS DE CICLOS ANUALES (Importado de ciclos.html) ---

const correctBaseNumberData = {
     1970: 3, 1971: 2, 1972: 1, 1973: 9, 1974: 8, 1975: 7, 1976: 6, 1977: 5, 1978: 4, 1979: 3,
     1980: 2, 1981: 1, 1982: 9, 1983: 8, 1984: 7, 1985: 6, 1986: 5, 1987: 4, 1988: 3, 1989: 2,
     1990: 1, 1991: 9, 1992: 8, 1993: 7, 1994: 6, 1995: 5, 1996: 4, 1997: 3, 1998: 2, 1999: 1,
     2000: 9, 2001: 8, 2002: 7, 2003: 6, 2004: 5, 2005: 4, 2006: 3, 2007: 2, 2008: 1, 2009: 9,
     2010: 8, 2011: 6, 2012: 5, 2013: 4, 2014: 3, 2015: 2, 2016: 1, 2017: 9, 2018: 8, 2019: 7,
     2020: 6, 2021: 5, 2022: 4, 2023: 3, 2024: 2, 2025: 1, 2026: 9, 2027: 8, 2028: 7, 2029: 6,
     2030: 5, 2031: 4, 2032: 3,
};

const elementData = {
    2021: [null, "Fuego", "Agua", "Tierra", "Trueno", "Viento", "Central", "Cielo", "Lago", "Montaña"],
    2022: [null, "Agua", "Tierra", "Trueno", "Viento", "Central", "Cielo", "Lago", "Montaña", "Fuego"],
    2023: [null, "Tierra", "Trueno", "Viento", "Central", "Cielo", "Lago", "Montaña", "Fuego", "Agua"],
    2024: [null, "Trueno", "Viento", "Central", "Cielo", "Lago", "Montaña", "Fuego", "Agua", "Tierra"],
    2025: [null, "Viento", "Central", "Cielo", "Lago", "Montaña", "Fuego", "Agua", "Tierra", "Trueno"],
    2026: [null, "Central", "Cielo", "Lago", "Montaña", "Fuego", "Agua", "Tierra", "Trueno", "Viento"],
    2027: [null, "Cielo", "Lago", "Montaña", "Fuego", "Agua", "Tierra", "Trueno", "Viento", "Central"],
    2028: [null, "Lago", "Montaña", "Fuego", "Agua", "Tierra", "Trueno", "Viento", "Central", "Cielo"],
    2029: [null, "Montaña", "Fuego", "Agua", "Tierra", "Trueno", "Viento", "Central", "Cielo", "Lago"],
    2030: [null, "Fuego", "Agua", "Tierra", "Trueno", "Viento", "Central", "Cielo", "Lago", "Montaña"],
};

const elementInterpretations = {
    "Tierra": "Prioriza lo práctico, el autocuidado, la constancia y la maduración.",
    "Trueno": "Ideal para romper viejos patrones y atreverse. Siempre, planta nuevos proyectos aunque todo tiemble.",
    "Viento": "Favorece la adaptabilidad. Ideal para un viaje, ábrete a nuevas ideas, conecta con gente.",
    "Central": "Momento para soltar el pasado y reequilibrar. Se avecinan cambios importantes para reencontrar tu propósito.",
    "Cielo": "Ideal para visualizar el futuro, iniciar proyectos ambiciosos y conectar con lo trascendente.",
    "Lago": "Potencia la introspección, el placer simple, la apertura receptiva y el arte de escuchar.",
    "Montaña": "No es momento de avanzar sin reflexión; mantente en tu centro y escucha tu interior.",
    "Fuego": "Ideal para proyectos creativos, comunicarte y liderar desde la autenticidad, pero sin quemarte.",
    "Agua": "Fluye. Tiempo de confiar, dejarse llevar, sanar viejas heridas y conectar con la intuición."
};

const momentInterpretations = {
    1: "Personas preocupadas por la familia y el hogar. Año de nuevos comienzos, creatividad e independencia.",
    2: "Año de cooperación y de construir relaciones. La paciencia y la diplomacia son clave.",
    3: "Un año maravilloso para actividades sociales y la autoexpresión. Diviértete y sé optimista.",
    4: "Paciencia, trabajo y disciplina. Es un año para construir para el futuro. Presta atención a los detalles.",
    5: "Puedes aprender una nueva habilidad o es momento de terminar tu educación. Tiempo de viajar, generar nuevas ideas o hacer contactos. La idea de servir a los demás (incondicionalmente y sin tratar de controlar) es especialmente importante.",
    6: "Año para experimentar alegría en las relaciones. Momento de resolver problemas con familiares y amigos.",
    7: "Cuida tu salud. Un tiempo para el desarrollo interior y el crecimiento espiritual. Un tiempo de reflexión.",
    8: "Fuerza interior y poder personal. Un año para organizarse y hacerse cargo de la propia vida.",
    9: "Actuar con compasión y tolerancia. Un tiempo para completar y mirar hacia atrás a lo que has aprendido."
};
/**
 /**
 * Carga de forma diferida los textos de análisis para no bloquear el renderizado inicial.
 * @returns {Promise<object>} Una promesa que resuelve con los textos.
 */

// REEMPLAZA LA FUNCIÓN getAnalysisTexts COMPLETA CON ESTA VERSIÓN CORREGIDA:

const getAnalysisTexts = () => {
    // Caché en módulo para evitar lecturas repetidas
    if (getAnalysisTexts.__cache) return Promise.resolve(getAnalysisTexts.__cache);
    if (getAnalysisTexts.__pending) return getAnalysisTexts.__pending;

    getAnalysisTexts.__pending = (async () => {
        try {
            const app = getApps().length ? getApp() : initializeApp(firebaseConfig);
            const auth = getAuth(app);
            try {
                if (!auth.currentUser) {
                    await signInAnonymously(auth);
                    await new Promise(resolve => { 
                        const unsub = onAuthStateChanged(auth, () => { 
                            unsub(); 
                            resolve(); 
                        }); 
                    });
                }
            } catch (e) {
                console.warn('Error en autenticación:', e);
            }
            
            const db = __getDb(app, FIRESTORE_DB_ID);

            const readDoc = async (col, id) => {
                try {
                    const snap = await getDoc(doc(db, col, id));
                    if (snap.exists()) {
                        const data = snap.data();
                        console.log(`Documento ${col}/${id} cargado:`, Object.keys(data || {}));
                        return data;
                    } else {
                        console.warn(`Documento no encontrado: ${col}/${id}`);
                        return null;
                    }
                } catch (e) {
                    console.warn(`Error leyendo ${col}/${id}:`, e);
                    return null;
                }
            };

            // Cargar documentos con los nombres correctos (nota: talentos en plural)
            const [
                karma, karma_alt,
                talento, talento_alt,  // El código seguirá usando estos nombres
                objetivos, objetivos_alt,
                mision, mision_alt,
                personalSynthesisSnippets,
                structuredData
            ] = await Promise.all([
                readDoc('analisistextos', 'karma'),
                readDoc('analisistextos', 'karma_alternativo'),
                readDoc('analisistextos', 'talentos'), // CAMBIO: usar 'talentos' en plural
                readDoc('analisistextos', 'talento_alternativo'),
                readDoc('analisistextos', 'objetivos'),
                readDoc('analisistextos', 'objetivos_alternativo'),
                readDoc('analisistextos', 'misión'),
                readDoc('analisistextos', 'mision_alternativo'),
                readDoc('sintesispersonal', 'personalSynthesisSnippets'),
                readDoc('datosestructurados', 'structuredData')
            ]);

            // Función para generar textos por defecto
            const getDefaultTexts = () => {
                const defaultText = {};
                for (let i = 1; i <= 22; i++) {
                    for (let j = 1; j <= 9; j++) {
                        const key = `${i}-${j}`;
                        defaultText[key] = `Análisis para la energía ${key} no disponible. Los textos están siendo actualizados.`;
                    }
                }
                return defaultText;
            };

            const getDefaultSnippets = () => ({
                mission: {},
                objective: {},
                talent: {},
                karma: {},
                expansion: {}
            });

            // Construir el objeto de textos de análisis
            const analysisTexts = {
                Karma: karma || getDefaultTexts(),
                KarmaAlternative: karma_alt || getDefaultTexts(),
                Talent: talento || getDefaultTexts(), // Usar el documento 'talentos' aquí
                TalentAlternative: talento_alt || getDefaultTexts(),
                Goal: objetivos || getDefaultTexts(),
                GoalAlternative: objetivos_alt || getDefaultTexts(),
                Mission: mision || getDefaultTexts(),
                MissionAlternative: mision_alt || getDefaultTexts(),
            };

            // Verificar si los documentos tienen la estructura esperada
            console.log('Estructura de datos cargada:');
            for (const [key, value] of Object.entries(analysisTexts)) {
                if (value && typeof value === 'object') {
                    const keys = Object.keys(value);
                    console.log(`${key}: ${keys.length} energías cargadas`);
                    if (keys.length > 0 && keys.length < 5) {
                        console.log(`  Primeras claves: ${keys.slice(0, 5).join(', ')}`);
                    }
                }
            }

            const result = { 
                analysisTexts, 
                personalSynthesisSnippets: personalSynthesisSnippets || getDefaultSnippets(),
                structuredData: structuredData || {}
            };

            // Inmutables para seguridad
            try {
                Object.freeze(analysisTexts);
                Object.freeze(result.personalSynthesisSnippets);
                Object.freeze(result.structuredData);
            } catch {}

            getAnalysisTexts.__cache = result;
            return result;
        } catch (err) {
            console.error('Error cargando textos de análisis:', err);
            // En caso de error, devolver estructura con valores por defecto
            const fallbackResult = {
                analysisTexts: {
                    Karma: getDefaultTexts(),
                    KarmaAlternative: getDefaultTexts(),
                    Talent: getDefaultTexts(),
                    TalentAlternative: getDefaultTexts(),
                    Goal: getDefaultTexts(),
                    GoalAlternative: getDefaultTexts(),
                    Mission: getDefaultTexts(),
                    MissionAlternative: getDefaultTexts()
                },
                personalSynthesisSnippets: {
                    mission: {},
                    objective: {},
                    talent: {},
                    karma: {},
                    expansion: {}
                },
                structuredData: {}
            };
            
            // Función auxiliar para generar textos por defecto
            function getDefaultTexts() {
                const defaultText = {};
                for (let i = 1; i <= 22; i++) {
                    for (let j = 1; j <= 9; j++) {
                        const key = `${i}-${j}`;
                        defaultText[key] = `Análisis para la energía ${key} no disponible temporalmente.`;
                    }
                }
                return defaultText;
            }
            
            getAnalysisTexts.__cache = fallbackResult;
            return fallbackResult;
        } finally {
            getAnalysisTexts.__pending = null;
        }
    })();

    return getAnalysisTexts.__pending;
};
;

// =================================================================================

// === MÓDULO DE UTILIDADES: Procesamiento de Texto ================================
// =================================================================================

/**
 * Normaliza la puntuación y las mayúsculas para un formato consistente.
 * @param {string} text - El texto de entrada.
 * @returns {string} El texto formateado.
 */
function normalizePunctuationAndCapitalization(text) {
    if (!text || typeof text !== 'string') return '';
    return text
        .replace(REGEX.spaceBeforePunct, '$1')
        .replace(REGEX.ensureSpaceAfter, '$1 ')
        .replace(/\. com/gi, '.com') // Corrección específica para dominios
        .replace(REGEX.capAfterEnd, (_, p1, p2) => p1 + p2.toUpperCase())
        .replace(REGEX.capAfterInverted, (_, p1, p2) => p1 + p2.toUpperCase())
        .replace(REGEX.dblSpaces, ' ')
        .replace(REGEX.nbsp, ' ')
        .replace(REGEX.ellipsisFix1, '$1.$2')
        .replace(REGEX.ellipsisFix2, '...')
        .trim();
}

/**
 * Adapta el texto por género y tiempo/persona (para personas fallecidas).
 * @param {string} text - El texto de entrada para adaptar.
 * @param {'m'|'f'} gender - El género de la persona.
 * @param {boolean} isDeceased - Si la persona ha fallecido.
 * @returns {string} El texto adaptado.
 */
function adaptTextForPerspective(text, gender, isDeceased) {
    if (!text || typeof text !== 'string') return '';
    let adaptedText = text;

    if (isDeceased) {
        // --- Paso 1: Convertir narrativa de 2ª a 3ª persona ---
        adaptedText = adaptedText
            .replace(/\b([Tt])u\b/g, (match, p1) => p1 === 'T' ? 'Su' : 'su')
            .replace(/\b([Tt])us\b/g, (match, p1) => p1 === 'T' ? 'Sus' : 'sus')
            .replace(/\b([Cc])ontigo\b/g, (match, p1) => p1 === 'C' ? 'Consigo' : 'consigo')
            .replace(/\b([Tt])i\b/g, (match, p1) => p1 === 'T' ? 'Sí' : 'sí')
            .replace(REGEX.tePronoun, 'se')
            .replace(/\btú\b/gi, 'él'); // Se corregirá a 'ella' si es femenino

        // --- Paso 2: Convertir terminaciones verbales reflexivas ---
        adaptedText = adaptedText
            .replace(/(\w+)[áa]ndote\b/g, '$1ándose')
            .replace(/(\w+)[ie]ndote\b/g, '$1iéndose')
            .replace(/(\w+)arte\b/g, '$1arse')
            .replace(/(\w+)erte\b/g, '$1erse')
            .replace(/(\w+)irte\b/g, '$1irse')
            .replace(/\bsentirte\b/g, 'sentirse')
            .replace(/\bdonde terminas tú\b/g, 'donde terminaba');

        // --- Paso 3: Convertir verbos y frases clave a tiempo pasado ---
        const verbMap = {
            'eres': 'era', 'estás': 'estaba', 'tienes': 'tenía', 'puedes': 'podía', 'sabes': 'sabía',
            'vienes': 'venía', 'necesitas': 'necesitaba', 'sientes': 'sentía', 'aspiras': 'aspiraba',
            'anhelas': 'anhelaba', 'buscas': 'buscaba', 'cuentas con': 'contaba con', 'creas': 'creaba',
            'defines': 'definía', 'demuestras': 'demostraba', 'enseñas': 'enseñaba', 'prosperas': 'prosperaba',
            'adaptas': 'se adaptaba', 'aferras': 'se aferraba', 'conviertes': 'se convertía', 'llevas': 'llevaba',
            'mantienes': 'mantenía', 'ves': 'veía', 'vives': 'vivía', 'das': 'daba', 'genera': 'generaba',
            'actúas': 'actuaba', 'pierdes': 'perdía', 'enfoques': 'enfocara', 'equilibres': 'equilibrara',
            'uses': 'usara', 'superes': 'superara', 'reconozcas': 'reconociera', 'aceptes': 'aceptara',
            'hayas': 'hubiera', 'confía': 'confiaba', 'aprende': 'aprendía', 'atrévete': 'se atrevía',
            'abre': 'abría', 'libérate': 'se liberaba', 'resuelve': 'resolvía', 'no la ocultes': 'no la ocultaba',
            'evita': 'evitaba', 'consiste': 'consistía', 'mantiene': 'mantenía', 'enseña': 'enseñaba', 'acepta': 'aceptaba', 'son': 'eran', 'haces': 'hacía', 'puede': 'podía'
        };
        adaptedText = adaptedText.replace(new RegExp(`\\b(${Object.keys(verbMap).join('|')})\\b`, 'gi'), (match) => {
            const lowerMatch = match.toLowerCase();
            const replacement = verbMap[lowerMatch];
            return match.charAt(0) === lowerMatch.charAt(0) ? replacement : replacement.charAt(0).toUpperCase() + replacement.slice(1);
        });
        
        // --- Paso 4: Inyectar pronombre sujeto para mayor claridad ---
        const sujeto = gender === 'f' ? 'Ella' : 'Él';
        const verbStarts = ['Era', 'Estaba', 'Tenía', 'Podía', 'Buscaba', 'Anhelaba', 'Vivía', 'Veía', 'Mantenía', 'Llevaba', 'Demostraba', 'Enseñaba', 'Prosperaba', 'Convertía', 'Creaba', 'Definía', 'Contaba', 'Generaba', 'Actuaba', 'Perdía', 'Evitaba'];
        adaptedText = adaptedText.replace(new RegExp(`(^|[.!?]\\s+)(${verbStarts.join('|')})\\b`, 'g'), (_, p1, v) => `${p1}${sujeto} ${v.toLowerCase()}`);
        adaptedText = adaptedText.replace(/puede llevarte/gi, gender === 'm' ? 'podía llevarlo' : 'podía llevarla');
    }

    // --- Paso 5: Aplicar adaptaciones específicas de género ---
    if (gender === 'f') {
        const nounsOr = 'catalizad|consej|construct|controlad|explorad|facilitad|finalizad|gobernad|inspirad|mediad|pacificad|pion|protect|sanad|mentor|autor|orad|invent|comunicad';
        adaptedText = adaptedText.replace(new RegExp(`\\b(un|el) (${nounsOr})or\\b`, 'g'), 'una $2ora');
        adaptedText = adaptedText.replace(new RegExp(`\\b(${nounsOr})or\\b`, 'g'), '$1ora');

        const adjectives = 'abrumad|alienad|analític|atad|auténtic|brillante|capaz|centrad|conectad|consciente|crític|creativ|desconectad|desarraigad|dispers|distante|dramátic|elegid|emocional|enfocad|enredad|estancad|estresad|excesiv|extraordinari|fanátic|frí|frustrad|fuerte|generos|hipersensible|human|indign|inspirad|intens|intuitiv|just|llamad|magnétic|metódic|motiv|nacid|natural|obsesionad|oprimid|optimist|organizad|poderos|positiv|práctic|protector|rígid|sabi|sensible|sol|terc|visionari|vulnerable|ordenad|motivacional|comprometid|resuelt|confiad|entregad|seguro|perdid|insegur';
        adaptedText = adaptedText.replace(new RegExp(`\\b(${adjectives})o\\b`, 'g'), '$1a');
        
        adaptedText = adaptedText
            .replace(/\bél\b/g, 'ella')
            .replace(/\beres el que\b/gi, 'eres la que')
            .replace(/\bun maestro nato\b/g, 'una maestra nata')
            .replace(/\bun eterno aprendiz\b/g, 'una eterna aprendiz')
            .replace(/\bel 'aprendiz de todo, maestro de nada'\b/g, "la 'aprendiz de todo, maestra de nada'")
            .replace(/\bel "mediador"\b/g, 'la "mediadora"')
            .replace(/\bmaestro\b/g, 'maestra')
            .replace(/\b(un|el) guía\b/g, 'una guía')
            .replace(/\bun pacificador\b/g, 'una pacificadora')
            .replace(/a ti mismo\b/g, 'a ti misma')
            .replace(/contigo mismo\b/g, 'contigo misma')
            .replace(/sí mismo\b/g, 'sí misma');
        
        adaptedText = adaptedText
            .replace(/todo está conectada/g, 'todo está conectado')
            .replace(/un enfoque equilibrada/g, 'un enfoque equilibrado');
    }

    return adaptedText;
}

/**

 * Pipeline completo para procesar un texto sin formato a una versión final lista para mostrar.
 * @param {string} text - El texto de entrada sin procesar.
 * @param {'m'|'f'} gender - El género de la persona.
 * @param {boolean} isDeceased - Si la persona ha fallecido.
 * @returns {string} El texto completamente procesado.
 */
function adaptTextPipeline(text, gender, isDeceased) {
    const adaptedText = adaptTextForPerspective(text, gender, isDeceased);
    return normalizePunctuationAndCapitalization(adaptedText);
}

// =================================================================================
// === MÓDULO DE LÓGICA: Motor de Cálculo Numerológico =============================
// =================================================================================
// Objeto que encapsula toda la lógica de cálculo numerológico.
const calculationEngine = {
    conversionTable: { 'A': 1, 'B': 2, 'C': 11, 'D': 4, 'E': 5, 'F': 17, 'G': 3, 'H': 5, 'I': 10, 'J': 10, 'K': 19, 'L': 12, 'M': 13, 'N': 14, 'Ñ': 3, 'O': 6, 'P': 17, 'Q': 19, 'R': 20, 'S': 15, 'T': 9, 'U': 6, 'V': 6, 'W': 6, 'X': 15, 'Y': 16, 'Z': 7, 'AH': 5, 'CH': 8, 'SH': 21, 'TA': 22, 'TH': 22, 'TZ': 18, 'WH': 16 },
    sumDigits: (num) => num.toString().split('').reduce((a, d) => a + +d, 0),
    reduceNumber: function(num) {
        if (num >= 1 && num <= 22) return num;
        let s = this.sumDigits(num);
        while (s > 22) s = this.sumDigits(s);
        return s;
    },
    reduceToSmallest: function(num) {
        let s = this.sumDigits(num);
        while (s >= 10) s = this.sumDigits(s);
        return s;
    },
    calculateAspectPair: function(numbers) {
        const arr = Array.isArray(numbers) ? numbers : [numbers];
        if (!arr.length) return 'N/A';
        const sum = arr.reduce((a, n) => a + n, 0);
        let left = this.reduceNumber(sum);
        let right = this.reduceToSmallest(left);
        if (left === 19) right = 1;
        return `${left}-${right}`;
    },
    getPhoneticValues: function(name) {
        const preNormalized = name.replace(/ñ/gi, (match) => match === 'ñ' ? '__LOWER_ENYE__' : '__UPPER_ENYE__');
        const normalized = preNormalized.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
        const restored = normalized.replace(/__LOWER_ENYE__/g, 'ñ').replace(/__UPPER_ENYE__/g, 'Ñ');
        const words = restored.toUpperCase().split(/\s+/).filter(w => w.length > 0);
        const allVals = [];
    
        words.forEach((word, wordIndex) => {
            let i = 0;
            while (i < word.length) {
                let foundCombo = false;
                if (i + 1 < word.length) {
                    const twoLetterCombo = word.substring(i, i + 2);
                    if (this.conversionTable[twoLetterCombo]) {
                        allVals.push(this.conversionTable[twoLetterCombo]);
                        i += 2;
                        foundCombo = true;
                    }
                }
    
                if (!foundCombo) {
                    const singleLetter = word[i];
                    const isLastWord = wordIndex === words.length - 1;
                    const isLastLetterOfWord = i === word.length - 1;
    
                    if ((singleLetter === 'M' || singleLetter === 'P') && isLastWord && isLastLetterOfWord) {
                        allVals.push(12);
                    } else if (this.conversionTable[singleLetter]) {
                        allVals.push(this.conversionTable[singleLetter]);
                    }
                    i++;
                }
            }
        });
        return allVals;
    },

// REEMPLAZA TU FUNCIÓN calculatePlan CON ESTA VERSIÓN CORREGIDA

    // REEMPLAZA TU FUNCIÓN calculatePlan ENTERA POR ESTA VERSIÓN CORREGIDA

calculatePlan: async function(textsFromDb, name, day, month, year, gender, isDeceased) {
    // --- FUNCIÓN AUXILIAR PARA CÁLCULO ANUAL ---
    // La definimos aquí dentro para que no haya problemas de contexto con "this"
    const calculateYearlyCycle = (bDay, bMonth, bYear, targetYear) => {
        const reduceToSingleDigit = (num) => {
            let sum = num;
            while (sum > 9) {
                sum = String(sum).split('').reduce((acc, digit) => acc + parseInt(digit, 10), 0);
            }
            return sum;
        };

        const baseNumber = correctBaseNumberData[bYear];
        if (!baseNumber || !elementData[targetYear]) return null;

        const element = elementData[targetYear][baseNumber];
        const elementInterpretation = elementInterpretations[element] || "Sin interpretación.";

        const rootSum = String(bDay) + String(bMonth) + String(bYear);
        const root = reduceToSingleDigit(rootSum.split('').reduce((acc, digit) => acc + parseInt(digit, 10), 0));
        const targetYearReduced = reduceToSingleDigit(targetYear);
        const momentSum = root + targetYearReduced;
        const moment = reduceToSingleDigit(momentSum);
        const momentInterpretation = momentInterpretations[moment] || "Sin interpretación.";

        return { year: targetYear, element, elementInterpretation, moment, momentInterpretation };
    };
    // --- FIN DE LA FUNCIÓN AUXILIAR ---

    const { analysisTexts, personalSynthesisSnippets } = textsFromDb || (await getAnalysisTexts());
    const phonVals = this.getPhoneticValues(name);
    if (!phonVals.length) return null;

    const hasDate = day !== null && month !== null && year !== null;

    const age = hasDate ? (() => {
        const today = new Date();
        let a = today.getFullYear() - year;
        const m = today.getMonth() + 1;
        const d = today.getDate();
        return (m < month || (m === month && d < day)) ? a - 1 : a;
    })() : null;

    let pk, sk, pt, st, pg, sg, soulDestiny;
    const isShortName = phonVals.length < 10;

    if (!isShortName) {
        let aspects = { pk: [], sk: [], pt: [], st: [], pg: [], sg: [] };
        const keys = Object.keys(aspects);
        phonVals.forEach((v, i) => aspects[keys[i % keys.length]].push(v));
        pk = this.calculateAspectPair(aspects.pk);
        sk = this.calculateAspectPair(aspects.sk);
        pt = this.calculateAspectPair(aspects.pt);
        st = this.calculateAspectPair(aspects.st);
        pg = this.calculateAspectPair(aspects.pg);
        sg = this.calculateAspectPair(aspects.sg);
        const leftVal = p => (p && p !== 'N/A') ? +p.split('-')[0] : 0;
        const allLefts = [pk, sk, pt, st, pg, sg].map(leftVal);
        soulDestiny = this.calculateAspectPair(allLefts.reduce((a, n) => a + n, 0));
    } else {
        let aspects = { challenges: [], talents: [], goals: [] };
        const keys = Object.keys(aspects);
        phonVals.forEach((v, i) => aspects[keys[i % keys.length]].push(v));
        pk = this.calculateAspectPair(aspects.challenges); sk = pk;
        pt = this.calculateAspectPair(aspects.talents); st = pt;
        pg = this.calculateAspectPair(aspects.goals); sg = pg;
        soulDestiny = this.calculateAspectPair(phonVals.reduce((a, b) => a + b, 0));
    }

    const getRawAnalysisText = (type, pair, isAlternative = false) => {
    const key = isAlternative ? `${type}Alternative` : type;
    const textSet = analysisTexts[key] || analysisTexts[type] || {};
    return textSet[pair] || `Análisis para la energía ${pair} (${type}) no disponible. Los textos de análisis no se pudieron cargar desde la base de datos.`;
};

    const nameUn = phonVals.reduce((a, n) => a + n, 0);
    const esencia = this.calculateAspectPair(nameUn * nameUn);
    let aprendizaje = 'N/A', mision2 = 'N/A', birthDate = null;
    let yearlyCycles = []; // Inicializamos el array de ciclos

    if (hasDate) {
        const learningUn = day + this.sumDigits(month) + this.sumDigits(year);
        aprendizaje = this.calculateAspectPair(learningUn);
        mision2 = this.calculateAspectPair(nameUn + learningUn);
        birthDate = `${String(day).padStart(2, '0')}/${String(month).padStart(2, '0')}/${year}`;

        // --- BLOQUE DE CÁLCULO ANUAL ---
        const today = new Date();
        const currentYear = today.getFullYear();
        const currentMonth = today.getMonth() + 1;

        const currentYearCycle = calculateYearlyCycle(day, month, year, currentYear);
        if (currentYearCycle) {
            yearlyCycles.push(currentYearCycle);
        }

        // Si es julio o después, calcula el próximo año
        if (currentMonth >= 7) {
            const nextYearCycle = calculateYearlyCycle(day, month, year, currentYear + 1);
            if (nextYearCycle) {
                yearlyCycles.push(nextYearCycle);
            }
        }
    }

    const missionNum = soulDestiny.split('-')[0];
    const essenceNum = esencia.split('-')[0];
    let rawSintesis = '', rawAreasDeExpansion = '';

    if (hasDate) {
        const { talentPair, objectivePair, karmaPair } = age < 40 ? { talentPair: pt, objectivePair: pg, karmaPair: pk } : { talentPair: st, objectivePair: sg, karmaPair: sk };
        const talentNum = talentPair.split('-')[0];
        const objectiveNum = objectivePair.split('-')[0];
        const karmaNum = karmaPair.split('-')[0];

        rawSintesis = `Tu Misión Vital (${soulDestiny}) te impulsa a ${personalSynthesisSnippets.mission[missionNum] || 'realizar tu propósito único'}. En esta etapa de tu vida, esto se manifiesta a través de tu objetivo de ${personalSynthesisSnippets.objective[objectiveNum] || 'crecer y evolucionar'} (${objectivePair}).`;
        if (talentNum === karmaNum) {
            rawSintesis += ` Curiosamente, tu mayor talento y tu principal reto residen en la misma energía (${talentPair}), lo que significa que tu don es la clave para superar tu desafío: ${personalSynthesisSnippets.talent[talentNum] || 'usar tus dones innatos'}.`;
        } else {
            rawSintesis += ` Para ello, cuentas con tu gran talento (${talentPair}) que te da ${personalSynthesisSnippets.talent[talentNum] || 'tus dones innatos'}. A la vez, la vida te presenta el reto kármico de ${personalSynthesisSnippets.karma[karmaNum] || 'superar un aprendizaje fundamental'} (${karmaPair}).`;
        }
        rawSintesis += ` Todo esto se ve matizado por tu energía de Esencia (${esencia}), que te pide ${personalSynthesisSnippets.mission[essenceNum] || 'integrar una cualidad fundamental en tu ser'}.`;

        const karma1Num = pk.split('-')[0];
        const karma2Num = sk.split('-')[0];
        const aprendizajeNum = aprendizaje.split('-')[0];

        rawAreasDeExpansion = `Para acelerar tu crecimiento, el camino es transformar conscientemente tus aprendizajes kármicos. El reto de tu Karma I (${pk}) te invita a ${personalSynthesisSnippets.expansion[karma1Num] || 'prestar atención a esta lección para evolucionar'}.`;
        if (karma1Num === karma2Num) {
            rawAreasDeExpansion += ` Este aprendizaje se mantiene como tu foco principal a lo largo de tu vida, evolucionando hacia una expresión más madura y de servicio.`;
        } else {
            rawAreasDeExpansion += age >= 40 ? ` Ahora, en tu etapa de madurez, el Karma II (${sk}) te pide que te enfoques en ${personalSynthesisSnippets.expansion[karma2Num] || 'prestar atención a esta lección para evolucionar'}.` : ` Más adelante, el Karma II (${sk}) te pedirá que te enfoques en ${personalSynthesisSnippets.expansion[karma2Num] || 'prestar atención a esta lección para evolucionar'}.`;
        }
        rawAreasDeExpansion += ` Finalmente, tu gran lección de vida, marcada por tu fecha de tu nacimiento (${aprendizaje}), es un recordatorio constante para ${personalSynthesisSnippets.expansion[aprendizajeNum] || 'prestar atención a esta lección para evolucionar'}. Integrar estas tres lecciones es la clave de tu maestría.`;

    } else {
        const karma1Num = pk.split('-')[0];
        const talent1Num = pt.split('-')[0];
        const objective1Num = pg.split('-')[0];

        rawSintesis = `Tu Misión Vital (${soulDestiny}) te impulsa a ${personalSynthesisSnippets.mission[missionNum] || 'realizar tu propósito único'}. Como no conocemos tu edad, te presentamos las dos grandes etapas de la vida para tu reflexión. La primera etapa (I) se centra en el desarrollo personal y terrenal, mientras que la segunda (II) se enfoca en la maestría espiritual y el servicio.\n\nEn la primera etapa, tu objetivo sería ${personalSynthesisSnippets.objective[objective1Num] || 'crecer y evolucionar'} (${pg}), apoyándote en tu talento de ${personalSynthesisSnippets.talent[talent1Num] || 'usar tus dones'} (${pt}) y afrontando el reto de ${personalSynthesisSnippets.karma[karma1Num] || 'superar un aprendizaje'} (${pk}).\n\nEn la segunda, tu objetivo evolucionaría a ${personalSynthesisSnippets.objective[sg.split('-')[0]] || 'alcanzar la plenitud'} (${sg}), usando tu talento maduro de ${personalSynthesisSnippets.talent[st.split('-')[0]] || 'servir con tus dones'} (${st}) y transmutando el reto de ${personalSynthesisSnippets.karma[sk.split('-')[0]] || 'integrar una lección superior'} (${sk}).\n\nTodo esto se ve matizado por tu energía de Esencia (${esencia}), que te pide ${personalSynthesisSnippets.mission[essenceNum] || 'integrar una cualidad fundamental en tu ser'}.`;
        rawAreasDeExpansion = `Para acelerar tu crecimiento, el camino es transformar conscientemente tus aprendizajes kármicos. El reto de tu Karma I (${pk}) te invita a ${personalSynthesisSnippets.expansion[karma1Num] || 'prestar atención a esta lección para evolucionar'}.`;
        rawAreasDeExpansion += (pk === sk) ? ` Este aprendizaje se mantiene como tu foco principal a lo largo de tu vida, evolucionando hacia una expresión más madura y de servicio.` : ` A su vez, el Karma II (${sk}) te pide que te enfoques en ${personalSynthesisSnippets.expansion[sk.split('-')[0]] || 'prestar atención a esta lección para evolucionar'}. Integrar ambas lecciones es clave para tu maestría.`;
    }
    
    const firstName = name.split(' ')[0];
    const uiStrings = {
        TITLE_MAIN: isDeceased ? "Análisis del Plan de Vida" : "Tu Plan de Vida",
        SUBTITLE_ELABORADO: "Elaborado por Sergi Sai Mora",
        LABEL_FECHA_DESCONOCIDA: "Fecha desconocida",
        LINK_GUIA: "Descubre tu Plan de Vida en detalle con la Guía de los 22 Arquetipos (clica aquí)",
        CHART_LABEL_MISION: "MISIÓN",
        CHART_LABEL_OBJETIVO_I: "Objetivo I",
        CHART_LABEL_OBJETIVO_II: "Objetivo II",
        CHART_LABEL_KARMA_I: "Karma I",
        CHART_LABEL_KARMA_II: "Karma II",
        CHART_LABEL_TALENTO_I: "Talento I",
        CHART_LABEL_TALENTO_II: "Talento II",
        CHART_LABEL_OBJETIVOS_CORTOS: "Objetivos I & II",
        CHART_LABEL_KARMA_CORTOS: "Karma I & II",
        CHART_LABEL_TALENTOS_CORTOS: "Talentos I & II",
        CHART_LABEL_MISION_2: "Misión 2",
        CHART_LABEL_APRENDIZAJE: "Aprendizaje",
        CHART_LABEL_ESENCIA: "Esencia",
        INTRO_QUOTE: `<div style="line-height: 1.7;"><p style="font-size: 1.2em; font-weight: bold; margin-bottom: 1.5em; color: #31416b;">¿Quién soy? ¿Para qué estoy aquí?</p><br /><p style="margin-bottom: 1.2em;">Estas no son preguntas casuales, {firstName}. Son la señal inequívoca de que tu alma ha comenzado su despertar.</p><p style="margin-bottom: 1.2em;">La respuesta vive codificada en lo más profundo de tu identidad: en la <strong>vibración energética</strong> de tu nombre completo y tu fecha de nacimiento.</p><p style="margin-bottom: 1.2em;">Nada en el universo sucede por casualidad. Tus <strong>OBJETIVOS</strong> (esas aspiraciones que resuenan en tu corazón), tus <strong>TALENTOS</strong> (los dones naturales que te hacen brillar con luz propia), y tus <strong>KARMAS</strong> (los retos transformadores que impulsan tu evolución) están meticulosamente entretejidos en el tapiz de tu identidad.</p><h3 style="font-size: 1.2em; font-weight: bold; margin-top: 2em; margin-bottom: 1em; color: #31416b;">Tu Misión es la Síntesis de Todo Esto</h3><p style="margin-bottom: 1.2em;">Va más allá de cualquier meta externa. Es un estado de coherencia interna que florece cuando:</p><ul style="list-style-type: disc; margin-left: 20px; margin-top: 1em; margin-bottom: 1.2em;"><li><strong>Honras tus talentos</strong> expresándolos sin reservas en el mundo.</li><li><strong>Cultivas objetivos</strong> que te apasionan, pues resuenan con tu verdad más profunda.</li><li><strong>Abrazas tus karmas</strong> o lecciones pendientes como maestros que te moldean suavemente.</li></ul><h3 style="font-size: 1.2em; font-weight: bold; margin-top: 2em; margin-bottom: 1em; color: #31416b;">Lo que te comparto es el plan de tu alma:</h3><p style="margin-bottom: 1.2em;">El análisis vibracional de tu identidad más profunda, tu GPS vital, estructurado en dos etapas fundamentales:</p><p style="margin-left: 20px; margin-bottom: 0.5em;"><strong>Parte I: El Desarrollo de la Personalidad (Hasta los 35-42 años)</strong><br/>La época del autodescubrimiento, donde forjas tu personalidad y exploras las múltiples facetas de tu ser.</p><p style="margin-left: 20px; margin-bottom: 1.2em;"><strong>Parte II: La Trascendencia (Desde los 35-42 años en adelante)</strong><br/>El período de búsqueda profunda, donde encuentras el sentido último de tu existencia y te conviertes en un canal de contribución para la sociedad.</p><br /><p>Tu viaje no es solo tuyo, {firstName}. Es parte de una sinfonía cósmica donde cada nota cuenta, donde cada despertar individual eleva la conciencia colectiva.</p></div>`,
        H2_KARMA: "1. Retos y Aprendizajes (Karma)",
        H3_KARMA_1: "Karma I:",
        H3_KARMA_2: "Karma II:",
        H2_TALENTOS: "2. Talentos y Fortalezas",
        H3_TALENTO_1: "Talento I:",
        H3_TALENTO_2: "Talento II:",
        H2_OBJETIVOS: "3. Objetivos del Alma",
        H3_OBJETIVO_1: "Objetivo I:",
        H3_OBJETIVO_2: "Objetivo II:",
        H2_MISION_VITAL: "4. Tu Misión (Propósito de Vida):",
        H3_ESENCIA: isDeceased ? "La Esencia de su Misión:" : "La Esencia de tu Misión:",
        H3_MISION_2: isDeceased ? "Su Gran Misión:" : "Tu Gran Misión:",
        H3_APRENDIZAJE: "Un aprendizaje importante:",
        H2_SINTESIS: "5. Síntesis",
        H2_EXPANSION: "6. Áreas de Expansión",
        FINAL_QUOTE: isDeceased
            ? `"Este análisis es un tributo al viaje del alma de {firstName}. Que sirva como una reflexión sobre su legado y las energías que {objectPronoun} guiaron. Si este trabajo te ha resultado útil o inspirador, te agradecería que compartieras mi labor y animaras a otros a descubrir su propio plan de vida en __SERGIMORA_LINK__. Con gratitud y respeto."`
            : `"{firstName}, si esta visión resuena en tu interior, es porque sientes que estás {userActionWord} a hacerla realidad. Te agradecería mucho si compartes mi labor y animas a otros a suscribirse a mi newsletter en __SERGIMORA_LINK__. ¡Gracias de corazón y bendiciones!"`,
        FOOTER_LINK: "Pide Tu Plan de Vida personalizado en sergimora.com/plandevida"
    };

    return {
        NOMBRE_COMPLETO: name, FECHA_NACIMIENTO: birthDate, hasDate, isShortName, isDeceased, gender, age,
        energies: { pk, sk, pt, st, pg, sg, soulDestiny, aprendizaje, esencia, mision2 },
        yearlyCycles: yearlyCycles, // <-- AÑADIMOS LOS CICLOS AL OBJETO FINAL
        rawTexts: {
            ...uiStrings,
            ANÁLISIS_KARMA_1: getRawAnalysisText('Karma', pk),
            ANÁLISIS_KARMA_2: getRawAnalysisText('Karma', sk, pk === sk),
            ANÁLISIS_TALENTO_1: getRawAnalysisText('Talent', pt),
            ANÁLISIS_TALENTO_2: getRawAnalysisText('Talent', st, pt === st),
            ANÁLISIS_OBJETIVO_1: getRawAnalysisText('Goal', pg),
            ANÁLISIS_OBJETIVO_2: getRawAnalysisText('Goal', sg, pg === sg),
            ANÁLISIS_MISIÓN_PERSONALIZADO: getRawAnalysisText('Mission', soulDestiny),
            ANÁLISIS_MISIÓN_2: getRawAnalysisText('Mission', mision2, esencia === mision2),
            ANÁLISIS_ESENCIA: getRawAnalysisText('Mission', esencia),
            ANÁLISIS_APRENDIZAJE: getRawAnalysisText('Karma', aprendizaje),
            SÍNTESIS: rawSintesis,
            ÁREAS_DE_EXPANSIÓN: rawAreasDeExpansion,
        },
        personalSynthesisSnippets: personalSynthesisSnippets,
    };
},
};

// =================================================================================

// === CONTEXTO Y HOOKS DE FIREBASE ================================================
// =================================================================================

const FirebaseContext = createContext(null);
const useFirebase = () => useContext(FirebaseContext);

const FirebaseProvider = memo(({ children }) => {
    const [firebaseState, setFirebaseState] = useState({
        auth: null, db: null, userId: null, isAuthReady: false, authError: null,
    });

    const attemptSignIn = useCallback(async (authInstance) => {
        try {
            const token = typeof __initial_auth_token !== 'undefined' ? __initial_auth_token : null;
            if (token) {
                 // Custom token login disabled; falling back to anonymous sign-in
await signInAnonymously(authInstance).catch(async (e) => {
                    console.error("Inicio directo con sesión anónima (custom token desactivado por configuración).", e);
                    await signInAnonymously(authInstance);
                });
            } else {
                await signInAnonymously(authInstance);
            }
        } catch (error) {
            console.error("Error al iniciar sesión en Firebase:", error);
            setFirebaseState(s => ({ ...s, authError: "No se pudo iniciar sesión. Comprueba tu conexión." }));
        }
    }, []);

    useEffect(() => {
        let firebaseConfig;
        try {
            firebaseConfig = typeof __firebase_config !== 'undefined' ? JSON.parse(__firebase_config) : {};
        } catch (e) {
            console.error('Configuración de Firebase inválida:', e);
            setFirebaseState(s => ({ ...s, authError: 'Configuración de Firebase inválida.' }));
            return;
        }

        if (!firebaseConfig || Object.keys(firebaseConfig).length === 0) {
             setFirebaseState(s => ({ ...s, authError: 'Configuración de Firebase no encontrada.' }));
             return;
        }

        const app = getApps().length === 0 ? initializeApp(firebaseConfig) : getApp();
        const authInstance = getAuth(app);
        const dbInstance = __getDb(app, FIRESTORE_DB_ID);
        setLogLevel('debug');

        setFirebaseState(s => ({ ...s, auth: authInstance, db: dbInstance }));

        const unsubscribe = onAuthStateChanged(authInstance, (user) => {
            if (user) {
                setFirebaseState(s => ({ ...s, userId: user.uid, isAuthReady: true, authError: null }));
            } else {
                attemptSignIn(authInstance);
            }
        });

        return () => unsubscribe();
    }, [attemptSignIn]);

    const value = useMemo(() => ({
        ...firebaseState,
        appId: typeof __app_id !== 'undefined' ? __app_id : APP_CONFIG.DEFAULT_APP_ID,
        retrySignIn: () => firebaseState.auth && attemptSignIn(firebaseState.auth),
    }), [firebaseState, attemptSignIn]);

    return (
        <FirebaseContext.Provider value={value}>
            {value.authError && (
                <div className="bg-yellow-100 border-l-4 border-yellow-500 text-yellow-700 p-4 m-4 rounded-lg flex justify-between items-center" role="alert">
                    <div className="flex items-center"><IconAlertTriangle /><p className="ml-3 font-bold">{value.authError}</p></div>
                    <button onClick={value.retrySignIn} className="bg-yellow-500 hover:bg-yellow-600 text-white font-bold py-1 px-3 rounded">Reintentar</button>
                </div>
            )}
            {!value.isAuthReady && !value.authError && <div className="flex justify-center items-center h-screen"><p>Conectando de forma segura...</p></div>}
            {value.isAuthReady && children}
        </FirebaseContext.Provider>
    );
});

// =================================================================================
// === HOOKS PERSONALIZADOS DE LA APLICACIÓN =======================================
// =================================================================================

/**
 * Hook para gestionar el estado y la lógica del formulario de entrada.
 */
const usePlanForm = () => {
    const [name, setName] = useState('');
    const [day, setDay] = useState('');
    const [month, setMonth] = useState('');
    const [year, setYear] = useState('');
    const [gender, setGender] = useState('m');
    const [noDate, setNoDate] = useState(false);
    const [isDeceased, setIsDeceased] = useState(false);

    useEffect(() => {
        if (noDate) {
            setDay(''); setMonth(''); setYear('');
        }
    }, [noDate]);

    const getFormData = useCallback(() => {
        const normalizedName = name.trim().replace(/\s+/g, ' ');
        if (!normalizedName) return { error: 'El nombre completo es obligatorio.' };
        if (normalizedName.length > APP_CONFIG.MAX_NAME_LENGTH) return { error: `El nombre no puede exceder los ${APP_CONFIG.MAX_NAME_LENGTH} caracteres.` };

        if (noDate) return { name: normalizedName, day: null, month: null, year: null, gender, isDeceased };

        if (!day || !month || !year) return { error: 'Completa día, mes y año o marca "Sin fecha".' };
        
        const d = parseInt(day), m = parseInt(month), y = parseInt(year);
        const date = new Date(y, m - 1, d);
        if (!(date.getFullYear() === y && date.getMonth() === m - 1 && date.getDate() === d)) {
            return { error: 'La fecha introducida no es válida.' };
        }

        return { name: normalizedName, day: d, month: m, year: y, gender, isDeceased };
    }, [name, day, month, year, gender, noDate, isDeceased]);

    return { name, setName, day, setDay, month, setMonth, year, setYear, gender, setGender, noDate, setNoDate, isDeceased, setIsDeceased, getFormData };
};

// =================================================================================
// === FUNCIONES AUXILIARES PURAS (OPTIMIZACIÓN) ===================================
// =================================================================================

/**
 * Convierte un par de energía (ej: "7-7") a una cadena verbalizable (ej: "siete siete").
 * @param {string} pair - La cadena del par de energía.
 * @returns {string} La cadena verbalizable.
 */
const verbalizeEnergyPair = (pair) => {
    if (typeof pair !== 'string' || !pair.includes('-')) return pair;
    return pair.replace('-', ' ');
};

/**
 * 2. REEMPLAZA LA FUNCIÓN gatherRawDataForAI ORIGINAL CON ESTA
 * =============================================================
 * Recopila todos los textos en bruto y datos clave necesarios para la IA.
 * @param {object} plan - El objeto del plan de vida completo.
 * @param {object} allTexts - El objeto que contiene todos los análisis (analysisTexts).
 * @param {object} structuredData - El nuevo objeto con los datos de matices.
 * @returns {object} Un objeto con los datos listos para ser usados en el prompt.
 */
const gatherRawDataForAI = (plan, allTexts, structuredData) => { 
    const { energies, NOMBRE_COMPLETO, gender, age } = plan;
    const { pk, sk, pt, st, pg, sg, soulDestiny, aprendizaje, esencia, mision2 } = energies;

    // Función auxiliar para buscar datos estructurados de forma segura
    const getStructured = (pair) => structuredData[pair] || {};

    return {
        name: NOMBRE_COMPLETO.split(' ')[0],
        age: age,
        gender: gender === 'f' ? 'femenino' : 'masculino',
        // Textos narrativos base
        karma1: { code: pk, text: allTexts.Karma[pk] || "" },
        karma2: { code: sk, text: allTexts.Karma[sk] || "" },
        talent1: { code: pt, text: allTexts.Talent[pt] || "" },
        talent2: { code: st, text: allTexts.Talent[st] || "" },
        goal1: { code: pg, text: allTexts.Goal[pg] || "" },
        goal2: { code: sg, text: allTexts.Goal[sg] || "" },
        mission: { 
        code: soulDestiny, 
        text: allTexts.Mission[soulDestiny] || "",
        challengeText: allTexts.Karma[soulDestiny] || "" // <-- AÑADIR ESTA LÍNEA
    },
    esencia: { 
        code: esencia, 
        text: allTexts.Mission[esencia] || "",
        challengeText: allTexts.Karma[esencia] || "" // <-- AÑADIR ESTA LÍNEA TAMBIÉN PARA LA ESENCIA
    },
        learning: { code: aprendizaje, text: allTexts.Karma[aprendizaje] || "" },
        mission2: { code: mision2, text: allTexts.Mission[mision2] || "" },
        // Datos estructurados para matices
        structured: {
            karma1: getStructured(pk),
            karma2: getStructured(sk),
            talent1: getStructured(pt),
            talent2: getStructured(st),
            goal1: getStructured(pg),
            goal2: getStructured(sg),
            mission: getStructured(soulDestiny),
            esencia: getStructured(esencia),
            learning: getStructured(aprendizaje),
            mission2: getStructured(mision2)
        }
    };
};

/**
 * Convierte una cadena base64 a un Blob.
 * @param {string} b64Data - La cadena en base64.
 * @param {string} contentType - El tipo de contenido del Blob.
 * @param {number} sliceSize - El tamaño de las partes para el procesamiento.
 * @returns {Blob}
 */
const b64toBlob = (b64Data, contentType = '', sliceSize = 512) => {
    const byteCharacters = atob(b64Data);
    const byteArrays = [];
    for (let offset = 0; offset < byteCharacters.length; offset += sliceSize) {
        const slice = byteCharacters.slice(offset, offset + sliceSize);
        const byteNumbers = new Array(slice.length);
        for (let i = 0; i < slice.length; i++) {
            byteNumbers[i] = slice.charCodeAt(i);
        }
        const byteArray = new Uint8Array(byteNumbers);
        byteArrays.push(byteArray);
    }
    return new Blob(byteArrays, { type: contentType });
};

// =================================================================================
// === COMPONENTES DE LA INTERFAZ DE USUARIO (UI) ==================================
// =================================================================================

/**
 * Límite de Error para capturar errores de renderizado en sus hijos.
 */
class ErrorBoundary extends React.Component {
    constructor(props) { super(props); this.state = { hasError: false }; }
    static getDerivedStateFromError(error) { return { hasError: true }; }
    componentDidCatch(error, errorInfo) { console.error("Error capturado por ErrorBoundary:", error, errorInfo); }
    render() {
        if (this.state.hasError) {
            return (
                <div className="bg-red-100 border-l-4 border-red-500 text-red-700 p-4 rounded-lg" role="alert">
                    <h2 className="font-bold">Ocurrió un error</h2>
                    <p>No se pudo mostrar esta parte de la aplicación. Por favor, intente recargar la página.</p>
                </div>
            );
        }
        return this.props.children;
    }
}

/**
 * Formulario para introducir los datos del plan de vida.
 */
const PlanForm = memo(({ onSubmit, error, setError, isCalculating }) => {
    const form = usePlanForm();
    const nameId = useId(); const dayId = useId(); const monthId = useId(); const yearId = useId();
    const [infoVisible, setInfoVisible] = useState(false);

    const handleSubmit = useCallback((e) => {
        e.preventDefault();
        setError('');
        const formData = form.getFormData();
        if (formData.error) {
            setError(formData.error);
            return;
        }
        onSubmit(formData);
    }, [onSubmit, setError, form]);

    return (
        <div className="bg-white p-6 sm:p-8 rounded-xl shadow-lg">
            <div className="flex justify-between items-start mb-6">
                 <h2 className="text-2xl font-bold text-gray-700">Calcular Nuevo Plan de Vida</h2>
                 <button onClick={() => setInfoVisible(v => !v)} className="text-blue-600 hover:text-blue-800 font-semibold flex items-center gap-1 text-sm">
                    <span>¿Por qué estos datos?</span>
                    <IconChevronDown />
                 </button>
            </div>

            {infoVisible && (
                <div className="bg-blue-50 border border-blue-200 text-blue-800 p-4 rounded-lg mb-6 text-sm">
                    <p>La vibración energética de tu <strong>nombre completo</strong> y <strong>fecha de tu nacimiento</strong> codifica el mapa de tu alma: tus talentos, lecciones y propósito. Esta herramienta decodifica ese mapa para ofrecerte una guía. Tus datos no se almacenan y solo se usan para este cálculo.</p>
                </div>
            )}

            <form onSubmit={handleSubmit} className="space-y-6">
                <div>
                    <label htmlFor={nameId} className="block text-sm font-semibold text-gray-600 mb-1">Nombre Completo (tal como en el DNI)</label>
                    <input type="text" id={nameId} value={form.name} onChange={(e) => form.setName(e.target.value)} placeholder="Ej: Ana Sofía Pérez Ruiz" className="w-full p-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-400 focus:border-transparent transition duration-200 ease-in-out shadow-sm text-lg" required maxLength={APP_CONFIG.MAX_NAME_LENGTH} />
                </div>
                <div className="flex items-end gap-4">
                    <div className="flex-grow">
                        <label className={`block text-sm font-semibold mb-1 ${form.noDate ? 'text-gray-400' : 'text-gray-600'}`}>Fecha de Nacimiento</label>
                        <div className="flex flex-col sm:flex-row gap-2">
                            <input type="number" id={dayId} value={form.day} onChange={(e) => form.setDay(e.target.value)} placeholder="Día" min="1" max="31" className="w-full p-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-400 disabled:bg-gray-100" disabled={form.noDate} required={!form.noDate} />
                            <input type="number" id={monthId} value={form.month} onChange={(e) => form.setMonth(e.target.value)} placeholder="Mes" min="1" max="12" className="w-full p-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-400 disabled:bg-gray-100" disabled={form.noDate} required={!form.noDate} />
                            <input type="number" id={yearId} value={form.year} onChange={(e) => form.setYear(e.target.value)} placeholder="Año" min="1850" max={new Date().getFullYear()} className="w-full p-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-400 disabled:bg-gray-100" disabled={form.noDate} required={!form.noDate} />
                        </div>
                    </div>
                    <div className="pb-1">
                        <label className="flex items-center cursor-pointer"><input type="checkbox" checked={form.noDate} onChange={(e) => form.setNoDate(e.target.checked)} className="h-4 w-4 rounded text-blue-600 border-gray-300 focus:ring-blue-500"/><span className="ml-2 text-gray-700 font-semibold">Sin fecha</span></label>
                    </div>
                </div>
                <div>
                    <label className="block text-sm font-semibold text-gray-600 mb-2">Opciones</label>
                    <div className="flex items-center space-x-6">
                        <label className="flex items-center cursor-pointer"><input type="radio" name="gender" value="m" checked={form.gender === 'm'} onChange={(e) => form.setGender(e.target.value)} className="h-4 w-4 text-blue-600 border-gray-300 focus:ring-blue-500"/><span className="ml-2 text-gray-700">Masculino</span></label>
                        <label className="flex items-center cursor-pointer"><input type="radio" name="gender" value="f" checked={form.gender === 'f'} onChange={(e) => form.setGender(e.target.value)} className="h-4 w-4 text-pink-600 border-gray-300 focus:ring-pink-500"/><span className="ml-2 text-gray-700">Femenino</span></label>
                        <label className="flex items-center cursor-pointer"><input type="checkbox" checked={form.isDeceased} onChange={(e) => form.setIsDeceased(e.target.checked)} className="h-4 w-4 rounded text-gray-600 border-gray-300 focus:ring-gray-500"/><span className="ml-2 text-gray-700">Fallecido/a</span></label>
                    </div>
                </div>
                {error && <p className="text-red-600 bg-red-100 p-3 rounded-lg">{error}</p>}
                <div className="pt-2">
                    <button type="submit" disabled={isCalculating} className="w-full flex items-center justify-center gap-3 bg-blue-600 text-white font-bold py-3 px-4 rounded-lg hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 transition-colors duration-300 disabled:bg-gray-400 disabled:cursor-not-allowed">
                        <IconCalculator />
                        {isCalculating ? 'Calculando...' : 'Generar Plan y Guardar'}
                    </button>
                </div>
            </form>
        </div>
    );
});

/**
 * Renderiza el gráfico SVG de las energías numerológicas.
 */
const EnergyChartSVG = memo(({ energies, isShortName, hasDate, labels }) => {
    if (!energies || !labels) return null;
    const { pk, sk, pt, st, pg, sg, soulDestiny, aprendizaje, esencia, mision2 } = energies;
    
    const svgSize = 600, center = { x: svgSize / 2, y: svgSize / 2 };
    const R = 220, R_inner = 90, R_triangle_inner = 120;
    const sin60 = Math.sin(Math.PI / 3), cos60 = Math.cos(Math.PI / 3);
    const p1 = { x: center.x, y: center.y - R }, p2 = { x: center.x + R * sin60, y: center.y + R * cos60 }, p3 = { x: center.x - R * sin60, y: center.y + R * cos60 };
    const p4 = { x: center.x, y: center.y + R }, p5 = { x: center.x - R * sin60, y: center.y - R * cos60 }, p6 = { x: center.x + R * sin60, y: center.y - R * cos60 };
    const offset = 30;

    const TextLabel = ({ x, y, label, value, anchor = 'middle', valueFill = '#1d4ed8' }) => (
        <g>
            <text x={x} y={y - 10} textAnchor={anchor} fontSize="14" fontWeight="500" fill="#4b5563">{label}</text>
            <text x={x} y={y + 14} textAnchor={anchor} fontSize="18" fontWeight="700" fill={valueFill}>{value}</text>
        </g>
    );

    return (
        <div className="w-full flex justify-center no-print" style={{ pageBreakInside: 'avoid' }}>
            <svg aria-hidden="true" focusable="false" width="500" height="500" viewBox={`0 0 ${svgSize} ${svgSize}`}>
                {!isShortName ? (
                    <>
                        <polygon points={`${p1.x},${p1.y} ${p2.x},${p2.y} ${p3.x},${p3.y}`} stroke="#a855f7" strokeWidth="2.5" fill="none" />
                        <polygon points={`${p4.x},${p4.y} ${p5.x},${p5.y} ${p6.x},${p6.y}`} stroke="#60a5fa" strokeWidth="2.5" fill="none" />
                        <TextLabel x={center.x} y={p1.y - offset} label={labels.CHART_LABEL_OBJETIVO_II} value={sg} />
                        <TextLabel x={p6.x + offset} y={p6.y} label={labels.CHART_LABEL_KARMA_I} value={pk} anchor="start" />
                        <TextLabel x={p2.x + offset} y={p2.y} label={labels.CHART_LABEL_KARMA_II} value={sk} anchor="start" />
                        <TextLabel x={center.x} y={p4.y + offset} label={labels.CHART_LABEL_TALENTO_I} value={pt} />
                        <TextLabel x={p3.x - offset} y={p3.y} label={labels.CHART_LABEL_TALENTO_II} value={st} anchor="end" />
                        <TextLabel x={p5.x - offset} y={p5.y} label={labels.CHART_LABEL_OBJETIVO_I} value={pg} anchor="end" />
                    </>
                ) : (
                    <>
                        <polygon points={`${p1.x},${p1.y} ${p2.x},${p2.y} ${p3.x},${p3.y}`} stroke="#a855f7" strokeWidth="2.5" fill="none" />
                        <TextLabel x={center.x} y={p1.y - offset} label={labels.CHART_LABEL_OBJETIVOS_CORTOS} value={pg} />
                        <TextLabel x={p2.x + offset} y={p2.y - 40} label={labels.CHART_LABEL_KARMA_CORTOS} value={pk} anchor="start" />
                        <TextLabel x={p3.x - offset} y={p3.y - 40} label={labels.CHART_LABEL_TALENTOS_CORTOS} value={pt} anchor="end" />
                    </>
                )}
                <circle cx={center.x} cy={center.y} r={R_inner} stroke="#4b5563" strokeWidth="2" fill="none" />
                <polygon points={`${center.x},${center.y - R_triangle_inner} ${center.x + R_triangle_inner * sin60},${center.y + R_triangle_inner * cos60} ${center.x - R_triangle_inner * sin60},${center.y + R_triangle_inner * cos60}`} stroke="#4b5563" strokeWidth="2" fill="none" />
                {hasDate && <TextLabel x={center.x} y={center.y - R_triangle_inner - 20} label={labels.CHART_LABEL_MISION_2} value={mision2} valueFill="#7e22ce" />}
                {hasDate && <TextLabel x={center.x + R_triangle_inner * sin60 + 10} y={center.y + R_triangle_inner * cos60 + 25} label={labels.CHART_LABEL_APRENDIZAJE} value={aprendizaje} valueFill="#7e22ce" />}
                <TextLabel x={center.x - R_triangle_inner * sin60 - 10} y={center.y + R_triangle_inner * cos60 + 25} label={labels.CHART_LABEL_ESENCIA} value={esencia} valueFill="#7e22ce" />
                <text x={center.x} y={center.y + 40} textAnchor="middle" fontSize="20" fontWeight="700" fill="#1f2937">{labels.CHART_LABEL_MISION}</text>
                <text x={center.x} y={center.y + 10} textAnchor="middle" fontSize="48" fontWeight="800" fill="#7e22ce">{soulDestiny}</text>
            </svg>
        </div>
    );
});

/**
 * Muestra la cita final personalizada al final del informe.
 */
/**
 * Muestra la cita final personalizada al final del informe.
 */
const FinalQuote = memo(({ template, firstName, gender, isDeceased }) => {
    const finalHtml = useMemo(() => {
        if (!template) return "";
        const userActionWord = (gender === 'f' ? 'llamada' : 'llamado');
        const objectPronoun = (gender === 'm' ? 'lo' : 'la');
        const sergiMoraLink = `<a href="https://sergimora.com" target="_blank" rel="noopener noreferrer" class="report-link">sergimora.com</a>`;
        const ttLink = `<a href="https://tt.sergimora.com" target="_blank" rel="noopener noreferrer" class="report-link">https://tt.sergimora.com</a>`;

        return template
            .replace(/{firstName}/g, firstName)
            .replace(/{userActionWord}/g, userActionWord)
            .replace(/{objectPronoun}/g, objectPronoun)
            .replace(/__SERGIMORA_LINK__/g, sergiMoraLink)
            .replace(/__TT_LINK__/g, ttLink); // Se añade el manejo del nuevo enlace
    }, [template, firstName, gender, isDeceased]);

    return <div className="report-quote" dangerouslySetInnerHTML={{ __html: finalHtml }} />;
});

/**
 * Modal para mostrar el guion de audio, permitir copiarlo y descargarlo.
 */
const AudioScriptModal = memo(({ script, onClose, targetLanguage, planName }) => {
    const [copyButtonText, setCopyButtonText] = useState('Copiar Guión');
    const [isGeneratingAudio, setIsGeneratingAudio] = useState(false);
    const [audioError, setAudioError] = useState('');
    const [downloadButtonText, setDownloadButtonText] = useState('Descargar Audio');

    const handleCopy = useCallback(() => {
        const textarea = document.createElement('textarea');
        textarea.value = script;
        document.body.appendChild(textarea);
        textarea.select();
        try {
            document.execCommand('copy');
            setCopyButtonText('¡Copiado!');
        } catch (err) {
            console.error('Error al copiar el texto: ', err);
            setCopyButtonText('Error al copiar');
        }
        document.body.removeChild(textarea);
        setTimeout(() => setCopyButtonText('Copiar Guión'), 2000);
    }, [script]);

    const handleDownloadAudio = useCallback(async () => {
    // ...
    // --- LÍNEA AÑADIDA PARA LA CORRECCIÓN ---
    const scriptCorregido = script.replace(/\bnutre\b/gi, 'alimenta');
    // ---------------------------

    const MAX_LENGTH = 4500;
    const chunks = [];
    let currentChunk = "";
    const sentences = scriptCorregido.split(/(?<=[.!?])\s+/); // <-- SOLUCIÓN: Usar la variable corregida

        for (const sentence of sentences) {
            if (currentChunk.length + sentence.length > MAX_LENGTH) {
                chunks.push(currentChunk);
                currentChunk = sentence;
            } else {
                currentChunk += sentence + " ";
            }
        }
        chunks.push(currentChunk.trim());

        try {
            const voiceConfig = LANGUAGE_VOICE_MAP[targetLanguage] || LANGUAGE_VOICE_MAP['Español (original)'];

            const audioResponses = await Promise.all(chunks.map(chunk => {
                const payload = {
                    input: { text: chunk },
                    voice: { languageCode: voiceConfig.lang, name: voiceConfig.name },
                    audioConfig: { audioEncoding: 'MP3' }
                };

                return fetchWithTimeout(APP_CONFIG.CLOUD_FUNCTION_URL, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                }).then(res => {
                    if (!res.ok) throw new Error(`La llamada al asistente falló: ${res.statusText}`);
                    return res.json();
                });
            }));

            const audioBlobs = audioResponses.map(response => {
                if (!response.audioContent) throw new Error("La respuesta no contiene audio.");
                return b64toBlob(response.audioContent, 'audio/mpeg');
            });

            const combinedBlob = new Blob(audioBlobs, { type: 'audio/mpeg' });
            const url = window.URL.createObjectURL(combinedBlob);
            const a = document.createElement('a');
            a.style.display = 'none';
            a.href = url;
            const sanitizedName = planName.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-zA-Z0-9]/g, '_');
            a.download = `AudioPlanDeVida_${sanitizedName}.mp3`;
            document.body.appendChild(a);
            a.click();
            window.URL.revokeObjectURL(url);
            document.body.removeChild(a);
            setDownloadButtonText('¡Descargado!');

        } catch (err) {
            console.error('Error al generar el audio: ', err);
            setAudioError(`Error: ${err.message}`);
            setDownloadButtonText('Error');
        } finally {
            setIsGeneratingAudio(false);
            setTimeout(() => setDownloadButtonText('Descargar Audio'), 3000);
        }
    }, [script, targetLanguage, planName]);

    return (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex justify-center items-center z-50 p-4">
            <div className="bg-white rounded-lg shadow-xl p-6 w-full max-w-2xl max-h-[90vh] flex flex-col">
                <h3 className="text-xl font-bold text-gray-800 mb-4">Guión de Audio para Narración</h3>
                <p className="text-sm text-gray-600 mb-4">Puedes copiar este guión o descargarlo como un archivo de audio en el idioma seleccionado.</p>
                <textarea
                    readOnly
                    value={script}
                    className="w-full h-64 p-3 border border-gray-300 rounded-lg bg-gray-50 flex-grow"
                />
                {audioError && <p className="text-red-600 text-sm mt-2">{audioError}</p>}
                <div className="mt-6 flex flex-col sm:flex-row justify-end gap-4">
                    <button onClick={onClose} className="bg-gray-200 text-gray-800 font-bold py-2 px-4 rounded-lg hover:bg-gray-300">Cerrar</button>
                    <button onClick={handleCopy} className="bg-blue-600 text-white font-bold py-2 px-4 rounded-lg hover:bg-blue-700">{copyButtonText}</button>
                    <button onClick={handleDownloadAudio} disabled={isGeneratingAudio} className="flex items-center justify-center gap-2 bg-teal-500 text-white font-bold py-2 px-4 rounded-lg hover:bg-teal-600 disabled:bg-gray-400">
                        <IconDownload /> {downloadButtonText}
                    </button>
                </div>
            </div>
        </div>
    );
});


// =================================================================
// === REEMPLAZA TU COMPONENTE PlanReportComponent CON ESTE CÓDIGO ===
// =================================================================
const PlanReportComponent = memo(({ plan, onNew, isPdfReady, reportTitleRef }) => {
    const reportElementRef = useRef(null);
    const buttonsContainerRef = useRef(null);
    const [processedTexts, setProcessedTexts] = useState(null);
    const [isPolishing, setIsPolishing] = useState(false);
    const [reviewMessage, setReviewMessage] = useState('');
    const [targetLanguage, setTargetLanguage] = useState('Español (original)');
    const [isAudioModalOpen, setIsAudioModalOpen] = useState(false);
    const [audioScript, setAudioScript] = useState('');
    const [copyButtonText, setCopyButtonText] = useState('Copiar Texto');

    const isNonSpanish = useMemo(() => targetLanguage !== 'Español (original)', [targetLanguage]);
    const guideUrl = useMemo(() => isNonSpanish ? 'https://coach.sergimora.com/guide' : 'https://sergimora.com/guia', [isNonSpanish]);
    const footerUrl = useMemo(() => isNonSpanish ? 'https://sergimora.com/soulblueprint' : 'https://sergimora.com/plandevida', [isNonSpanish]);

    useEffect(() => {
        if (!plan || !plan.rawTexts) {
            setProcessedTexts(null);
            return;
        }
        const newProcessedTexts = {};
        for (const key in plan.rawTexts) {
            if (Object.prototype.hasOwnProperty.call(plan.rawTexts, key)) {
                newProcessedTexts[key] = adaptTextPipeline(plan.rawTexts[key], plan.gender, plan.isDeceased);
            }
        }

        if (isNonSpanish) {
            if (newProcessedTexts.FINAL_QUOTE) {
                newProcessedTexts.FINAL_QUOTE = `"{firstName}, I would be grateful if you shared my work and encouraged others to learn more about my work at __TT_LINK__. Thank you from the heart and blessings!"`;
            }
            if (newProcessedTexts.FOOTER_LINK) {
                newProcessedTexts.FOOTER_LINK = "Request Your Personalized Life Blueprint at sergimora.com/soulblueprint";
            }
        }
        
        setProcessedTexts(newProcessedTexts);
    }, [plan, isNonSpanish, plan.gender, plan.isDeceased]);

    // <--- FUNCIÓN handleExportPDF AÑADIDA ---
    const handleExportPDF = useCallback(() => {
        if (!reportElementRef.current || !window.html2pdf) {
            console.error("html2pdf no está listo o el elemento del informe no existe.");
            return;
        }
        const element = reportElementRef.current;
        const opt = {
            margin: [0.5, 0.5, 0.8, 0.5],
            filename: `PlanDeVida_${plan.NOMBRE_COMPLETO.replace(/ /g, '_')}.pdf`,
            image: { type: 'jpeg', quality: 0.98 },
            html2canvas: { scale: 3, useCORS: true },
            jsPDF: { unit: 'in', format: 'a4', orientation: 'portrait' }
        };
        window.html2pdf().from(element).set(opt).save();
    }, [plan, reportElementRef]);

    // <--- VERSIÓN CORRECTA DE handleCopyReport CON FALLBACK ---
    const handleCopyReport = useCallback(() => {
        if (!processedTexts || !plan) return;

        const fallbackCopy = (text) => {
            const textArea = document.createElement("textarea");
            textArea.value = text;
            textArea.style.position = "fixed";
            textArea.style.top = "-9999px";
            textArea.style.left = "-9999px";
            document.body.appendChild(textArea);
            textArea.focus();
            textArea.select();
            try {
                document.execCommand('copy');
                setCopyButtonText('¡Copiado!');
            } catch (err) {
                console.error('Error en el fallback de copiado:', err);
                setCopyButtonText('Error al copiar');
            }
            document.body.removeChild(textArea);
            setTimeout(() => setCopyButtonText('Copiar Texto'), 2500);
        };

        const cleanIntroHTML = (htmlString) => {
            const firstName = plan.NOMBRE_COMPLETO.split(' ')[0];
            const withName = htmlString.replace(/{firstName}/g, firstName);
            return withName.replace(/<p[^>]*>/g, '\n').replace(/<br\s*\/?>/g, '\n').replace(/<[^>]*>/g, '').replace(/\n+/g, '\n').trim();
        };

        const textParts = [
            cleanIntroHTML(processedTexts.INTRO_QUOTE),
            `\n\n${processedTexts.H2_KARMA}`,
            `${processedTexts.H3_KARMA_1} ${plan.energies.pk}`,
            processedTexts.ANÁLISIS_KARMA_1,
            `${processedTexts.H3_KARMA_2} ${plan.energies.sk}`,
            processedTexts.ANÁLISIS_KARMA_2,
            `\n\n${processedTexts.H2_TALENTOS}`,
            `${processedTexts.H3_TALENTO_1} ${plan.energies.pt}`,
            processedTexts.ANÁLISIS_TALENTO_1,
            `${processedTexts.H3_TALENTO_2} ${plan.energies.st}`,
            processedTexts.ANÁLISIS_TALENTO_2,
            `\n\n${processedTexts.H2_OBJETIVOS}`,
            `${processedTexts.H3_OBJETIVO_1} ${plan.energies.pg}`,
            processedTexts.ANÁLISIS_OBJETIVO_1,
            `${processedTexts.H3_OBJETIVO_2} ${plan.energies.sg}`,
            processedTexts.ANÁLISIS_OBJETIVO_2,
            `\n\n${processedTexts.H2_MISION_VITAL} ${plan.energies.soulDestiny}`,
            processedTexts.ANÁLISIS_MISIÓN_PERSONALIZADO,
            `${processedTexts.H3_ESENCIA} ${plan.energies.esencia}`,
            processedTexts.ANÁLISIS_ESENCIA,
        ];
        
        if (plan.hasDate) {
            textParts.push(
                `${processedTexts.H3_MISION_2} ${plan.energies.mision2}`,
                processedTexts.ANÁLISIS_MISIÓN_2,
                `${processedTexts.H3_APRENDIZAJE} ${plan.energies.aprendizaje}`,
                processedTexts.ANÁLISIS_APRENDIZAJE
            );
        }

        textParts.push(
            `\n\n${processedTexts.H2_SINTESIS}`,
            processedTexts.SÍNTESIS,
            `\n\n${processedTexts.H2_EXPANSION}`,
            processedTexts.ÁREAS_DE_EXPANSIÓN
        );

        const fullTextToCopy = textParts.join('\n\n').replace(/\n\n\n/g, '\n\n');

        if (navigator.clipboard && window.isSecureContext) {
            navigator.clipboard.writeText(fullTextToCopy).then(() => {
                setCopyButtonText('¡Copiado!');
                setTimeout(() => setCopyButtonText('Copiar Texto'), 2500);
            }).catch(err => {
                console.warn('El método moderno de copiado falló, usando fallback:', err);
                fallbackCopy(fullTextToCopy);
            });
        } else {
            console.warn('El método moderno de copiado no está disponible, usando fallback.');
            fallbackCopy(fullTextToCopy);
        }
    }, [processedTexts, plan]);

    // ... (El resto de tus funciones como handleGenerateYearlyCoachingScript, handleAIPolish, etc., van aquí sin cambios) ...
    // Asegúrate de que las demás funciones que ya tenías sigan aquí.

    const handleGenerateYearlyCoachingScript = useCallback(async () => {
    if (!plan || !plan.yearlyCycles || !plan.yearlyCycles.length) {
        setReviewMessage('No hay datos del ciclo anual. Se requiere una fecha de nacimiento.');
        setTimeout(() => setReviewMessage(''), 5000);
        return;
    }

    setIsPolishing(true);
    setReviewMessage('Creando tu guía anual personalizada...');

    const getYearlyCoachingPrompt = (plan) => {
        const { energies, age, yearlyCycles, rawTexts, NOMBRE_COMPLETO, gender } = plan;

        const firstName = NOMBRE_COMPLETO.split(' ')[0];
        const userGender = gender === 'm' ? 'HOMBRE' : 'MUJER';
        const currentYear = new Date().getFullYear();
        const isStageOne = age < 42;

        const currentKarma = isStageOne ? energies.pk : energies.sk;
        const karmaText = isStageOne ? rawTexts.ANÁLISIS_KARMA_1 : rawTexts.ANÁLISIS_KARMA_2;
        const currentTalent = isStageOne ? energies.pt : energies.st;
        const talentText = isStageOne ? rawTexts.ANÁLISIS_TALENTO_1 : rawTexts.ANÁLISIS_TALENTO_2;

        const yearData = yearlyCycles.find(c => c.year === currentYear) || yearlyCycles[0];
        const yearlyElement = yearData.element;
        const momentInterpretation = yearData.momentInterpretation;

        return `
            Eres un coach de vida y un narrador experto con un estilo directo, profundo y empoderador. Tu misión es crear un guion de reflexión breve y potente para un ${userGender}.

            **DATOS CLAVE DEL USUARIO:**
            - Nombre: ${firstName}
            - Edad: ${age}
            - Reto Principal: La energía ${currentKarma}, que se manifiesta como: "${karmaText}"
            - Talento Principal: La energía ${currentTalent}, que se manifiesta como: "${talentText}"
            - Energía del Año ${currentYear}: Elemento **${yearlyElement}**.
            - Oportunidades del Año: "${momentInterpretation}"

            **INSTRUCCIONES DE TONO Y ENFOQUE (LAS MÁS IMPORTANTES):**

            1.  **REENCUADRE POSITIVO OBLIGATORIO:** Sin importar la descripción del 'Reto', preséntalo SIEMPRE como un poder latente o un hábito que oculta una fortaleza. NUNCA definas a la persona por su problema. Establece su poder PRIMERO.
            2.  **ADAPTACIÓN POR EDAD (REGLA DE ORO):**
                * **Si la persona es adolescente (menor de 20 años):** Usa un lenguaje más simple, directo y relatable. Enfoca el mensaje en la **autenticidad, la creatividad, la confianza en la propia voz y la independencia**. Evita conceptos muy abstractos como "sabiduría ancestral" o "propósito de vida". Habla de "encontrar tu propio estilo", "empezar tus propios proyectos", "ser un buen amigo para ti mismo y para los demás".
                * **Si la persona es adulta (mayor de 20 años):** Usa un lenguaje más profundo y metafórico. Enfoca el mensaje en el **propósito, la maestría, la sabiduría y el servicio desde la plenitud**.

            **INSTRUCCIÓN DE METÁFORA ADAPTATIVA:**
            Elige la metáfora de la siguiente biblioteca basándote en el 'Elemento del Año' (${yearlyElement}) y úsala como eje para todo el guion.
            **== BIBLIOTECA DE METÁFORAS ==**
            - Tierra: **ÁRBOL** (Reto=viento, Talento=raíces).
            - Viento: **BARCO VELERO** (Reto=ancla, Talento=navegante).
            - Fuego: **FORJA** (Reto=metal frío, Talento=herrero).
            - Agua: **RÍO** (Reto=presas, Talento=fluidez).
            - Trueno: **TORMENTA y SEMILLA** (Reto=suelo duro, Talento=semilla).
            - Para otros: Crea una metáfora simple basada en su esencia.
            **== FIN DE LA BIBLIOTECA ==**

            **REGLAS DE NARRATIVA Y FORMATO:**
            1.  **FLUJO 'PODER -> RETO -> SOLUCIÓN':** Presenta primero la fortaleza inherente, luego el Reto que la oculta, y finalmente el Talento como la solución.
            2.  **INTEGRACIÓN, SIN JERGA:** Teje las 'Oportunidades del Año' en la narrativa. NO menciones los nombres de los números ('doce tres') ni términos como 'Momento'.
            3.  **FORMATO LIMPIO PARA VOZ:** SIN asteriscos, SIN paréntesis. Texto 100% limpio.

            **ESTRUCTURA DEL GUION (SIN ETIQUETAS):**
                * **1. Introducción Contextual:** Breve, explicando el propósito de la guía para el año ${currentYear}.
                * **2. Inicio Inmersivo:** Presenta la metáfora ELEGIDA, estableciendo primero el poder de la persona.
                * **3. Desarrollo:** Describe el Reto como un hábito y el Talento como la clave para liberarlo.
                * **4. Expansión:** Explica las Oportunidades del año como resultado de aplicar el Talento al Reto.
                * **5. Práctica Clave:** Un único ritual diario, simple, temático y adaptado a la edad.
                * **6. Declaración Final:** Una declaración de poder en primera persona, adaptada a la edad.

            Ahora, genera el guion completo para ${firstName} (${age} años) usando la metáfora correcta para su Elemento del año: **${yearlyElement}**, y aplicando rigurosamente todas las reglas de tono y adaptación por edad.
        `;
    };

    try {
        const prompt = getYearlyCoachingPrompt(plan);
        const payload = { contents: [{ role: "user", parts: [{ text: prompt }] }] };
        const result = await callGeminiWithBackoff(payload);
        const finalScript = result.candidates?.[0]?.content?.parts?.[0]?.text;

        if (!finalScript) throw new Error("La respuesta de la IA no tuvo el formato esperado.");
        
        const cleanScript = finalScript.replace(/[*()]/g, '').replace(/(\d+)-(\d+)/g, '$1 $2').replace(/:\s*\n/g, '.\n');
        setAudioScript(cleanScript);
        setIsAudioModalOpen(true);
        setReviewMessage('Guía anual generada con éxito.');

    } catch (err) {
        console.error('Error al generar la guía anual con IA:', err);
        const userFriendlyMessage = err.message.includes('503') ? 'El servicio está temporalmente sobrecargado. Por favor, inténtalo de nuevo en unos minutos.' : `Error al generar la guía: ${err.message}`;
        setReviewMessage(userFriendlyMessage);
    } finally {
        setIsPolishing(false);
        setTimeout(() => setReviewMessage(''), 7000);
    }
}, [plan]);

    const handleAIPolish = useCallback(async () => {
        setIsPolishing(true);
        setReviewMessage('');
        try {
            const textToPolish = Object.entries(processedTexts).filter(([_, value]) => typeof value === 'string' && value.trim().length > 0).map(([key, value]) => `[START:${key}]\n${value}\n[END:${key}]`).join('\n\n');
            const genderText = plan.gender === 'f' ? 'femenino' : 'masculino';
            const statusText = plan.isDeceased ? 'fallecida' : 'viva';
            const languageInstruction = targetLanguage === 'Español (original)' ? 'Pule el texto en su idioma original, español.' : `**ACCIÓN PRINCIPAL: Traduce y pule el texto a ${targetLanguage}.** El resultado final DEBE estar en ${targetLanguage}.`;
            const prompt = `Eres un editor experto y traductor con sensibilidad espiritual. Tu tarea es pulir y, si se solicita, traducir el siguiente texto de un análisis numerológico.
**Contexto Clave:**
- Persona: ${statusText}, género ${genderText}.
**Instrucciones Rigurosas:**
1.  **Acción:** ${languageInstruction}
2.  **Calidad:** Corrige cualquier error de gramática, puntuación y estilo. Asegura la coherencia de tiempo (pasado/3ª persona para fallecidos, presente/2ª persona para vivos) y de género.
3.  **Formato:** No alteres los placeholders ({firstName}, etc.) ni las URLs. Preserva intactos los identificadores [START:KEY] y [END:KEY]. No añadas texto fuera de estas etiquetas.
**Texto a Procesar:**
${textToPolish}`;
            setReviewMessage(`Traduciendo y puliendo a ${targetLanguage}...`);
            const payload = { contents: [{ role: "user", parts: [{ text: prompt }] }] };
            const result = await callGeminiWithBackoff(payload);
            const polishedText = result.candidates?.[0]?.content?.parts?.[0]?.text;
            if (!polishedText) throw new Error("La respuesta de la IA no tuvo el formato esperado.");
            const newTexts = { ...processedTexts };
            const sections = polishedText.split('[START:').slice(1);
            let updated = false;
            sections.forEach(section => {
                const keyMatch = section.match(/^(.*?)]/);
                if (keyMatch) {
                    const key = keyMatch[1];
                    const content = section.substring(keyMatch[0].length).split('[END:')[0].trim();
                    if (newTexts.hasOwnProperty(key)) {
                        newTexts[key] = content;
                        updated = true;
                    }
                }
            });
            if (updated) {
                setProcessedTexts(newTexts);
                setReviewMessage(`¡Texto pulido y traducido a ${targetLanguage}!`);
            } else {
                throw new Error("No se pudo analizar la respuesta de la IA.");
            }
        } catch (error) {
            console.error("Error al pulir el texto con IA:", error);
            const userFriendlyMessage = error.message.includes('503') ? 'El servicio está temporalmente sobrecargado. Se reintentará automáticamente en unos minutos.' : `Error: ${error.message}`;
            setReviewMessage(userFriendlyMessage);
        } finally {
            setIsPolishing(false);
            setTimeout(() => setReviewMessage(''), 7000);
        }
    }, [processedTexts, plan.gender, plan.isDeceased, targetLanguage]);

    const getOriginalSpanishPrompt = useCallback(async (plan) => {
    const { analysisTexts, structuredData } = await getAnalysisTexts();
    const rawData = gatherRawDataForAI(plan, analysisTexts, structuredData);
    const { energies, hasDate, age, isShortName } = plan;
    const { pk, soulDestiny } = energies;
    const getLeftNum = (pair) => pair ? pair.split('-')[0] : '';
    const holisticInsights = [];
    if (getLeftNum(pk) === getLeftNum(soulDestiny)) {
        holisticInsights.push(`Tu propósito principal te invita a transmutar la energía de tu reto kármico (${pk}) en tu mayor fortaleza, ya que vibra con la misma energía que tu Misión de Vida (${soulDestiny}).`);
    }
    if (isShortName) {
        let ageInstructions = `Instrucción (Sin Edad): Describe la influencia de las energías como un viaje continuo de maduración, siempre en términos arquetípicos.`;
        if (hasDate) {
            ageInstructions = `Instrucción de Edad (${age} años): Explica cómo la influencia de una energía puede sentirse de forma diferente en la juventud (como un reto crudo) versus en la madurez (como una oportunidad de sabiduría), **siempre en términos generales y arquetípicos, nunca personales**.`;
        }
        return `
            Eres un numerólogo experto y coach espiritual. Tu tono es sabio, empoderador y profundamente respetuoso.
            // --- REGLA MÁS IMPORTANTE DE TODAS ---
            REGLA INQUEBRANTABLE: NO ASUMIR NI INVENTAR LA HISTORIA PERSONAL
            Tu función más importante es describir la naturaleza arquetípica de cada energía (qué significa, qué retos y oportunidades presenta).
            1.  **PROHIBIDO INVENTAR:** Está estrictamente prohibido hacer suposiciones sobre las experiencias, acciones, pensamientos o emociones pasadas de la persona. NO uses frases como "Recuerdo tus años...", "Quizás sentiste...", "Probablemente hiciste...".
            2.  **ENFOQUE EN EL ARQUETIPO, NO EN LA BIOGRAFÍA:** En lugar de decir "tú te aferrabas al pasado", describe la energía: "La energía del karma 11-2 se manifiesta a menudo como una tendencia a aferrarse al pasado".
            3.  **INVITA, NO AFIRMES:** Presenta cada concepto como una invitación a la reflexión. El guion debe ser un mapa del mundo interior de la persona, no un relato de sus acciones pasadas.
            // --- FIN DE LA REGLA INQUEBRANTABLE ---
            FILOSOFÍA CLAVE DE LA NARRATIVA: MISIÓN EN CURSO
            Escribe desde la perspectiva de que la vida es un viaje en progreso. Usa un lenguaje que indique un camino continuo ("Eres llamado a...", "Tu camino te invita a...") y un tono humilde y alentador.
            REGLAS FUNDAMENTALES:
            1.  ESTRUCTURA DE UNA ETAPA: Esta persona tiene UN SOLO Reto, Talento y Objetivo a lo largo de TODA SU VIDA. La narrativa debe ser sobre la maduración de estas energías constantes.
            2.  FORMATO DE ENERGÍAS: Al mencionar una energía como '8-8', escríbela siempre sin guion: '8 8'.
            3.  FORMATO DE TEXTO: No uses NUNCA asteriscos (*) para marcar negritas ni ningún otro tipo de formato. El resultado debe ser texto plano.
            Datos de la Persona:
            - Nombre: ${rawData.name}
            - Edad: ${rawData.age ? rawData.age + ' años' : 'Desconocida'}
            - Género: ${rawData.gender}
            Instrucciones de Narrativa:
            - Adaptacion por Edad: ${ageInstructions}
            - Saludo: Comienza con "Querida [Nombre]," o "Querido [Nombre],".
            Material Base (Describe el significado de estas energías):
            - Misión de Vida (${rawData.mission.code}): Esta misión tiene una dualidad clave. Su potencial se expresa a través de tu Talento de Vida (${rawData.talent1.code}): '${rawData.talent1.text}'. **El reto de encarnar esta misión** es aprender a transmutar esta sombra: '${rawData.mission.challengeText}'. **IMPORTANTE: Al describir este reto, NO uses la palabra 'karma'. Refiérete a él como 'el reto de tu misión' o 'el aprendizaje de esta energía'.**
            - Esencia (${rawData.esencia.code}): ${rawData.esencia.text}
            - Gran Misión (${rawData.mission2.code}): ${rawData.mission2.text}
            - Aprendizaje Transversal (${rawData.learning.code}): ${rawData.learning.text}
            - RETO DE VIDA (Karma) (${rawData.karma1.code}): ${rawData.karma1.text}
            - TALENTO DE VIDA (Don) (${rawData.talent1.code}): ${rawData.talent1.text}
            - OBJETIVO DE VIDA (Enfoque) (${rawData.goal1.code}): ${rawData.goal1.text}
            Matices Adicionales:
            ${holisticInsights.map(insight => `- ${insight}`).join('\n')}
                Instrucción Final: Tu tarea es generar un guion narrativo EXTENSO y DETALLADO, como si fuera una meditación guiada sobre el plan del alma de la persona. Tu objetivo principal es expandir y dar vida a los textos base que te he proporcionado. No resumas en exceso; al contrario, profundiza. Utiliza las metáforas, imágenes y el lenguaje evocador específico de cada descripción para crear una experiencia inmersiva. Conecta las diferentes energías de forma fluida, manteniendo siempre un tono de sabio mentor que equilibra la visión espiritual elevada con reflexiones y preguntas que inviten a la persona a aplicar estos arquetipos en su día a día. El guion resultante debe ser significativamente más rico y largo que los textos del informe PDF, empoderando a la persona con una claridad y profundidad aún mayores para el camino que continúa.
        `;
    } else {
        let ageInstructions = '';
        if (hasDate) {
            if (age < 42) {
                ageInstructions = `Instrucción de Edad (Menor de 42): La persona está en su primera etapa o en transición. Describe las energías de la Etapa 1 como su foco actual. Presenta las de la Etapa 2 como un potencial futuro. Aplica la 'Filosofía de Misión en Curso' a todas las energías.`;
            } else {
                ageInstructions = `Instrucción de Edad (Mayor de 42): La persona está en su segunda etapa. Aplica la 'REGLA DE ORO PARA PERSONAS MADURAS' para invitar a la reflexión sobre las energías de la Etapa 1. Luego, describe las energías de la Etapa 2 aplicando la 'Filosofía de Misión en Curso', ya que esas son sus tareas actuales.`;
            }
        } else {
            ageInstructions = `Instrucción (Sin Edad): Presenta ambas etapas como las dos grandes fases del plan de vida, una como base de la otra, aplicando la 'Filosofía de Misión en Curso' a todas.`;
        }
        if (energies.pk === energies.sk) {
            holisticInsights.push("Como tu Reto se repite en ambas etapas, esto señala una lección central muy profunda que tu alma eligió experimentar y que requiere tu atención continua, transformándose en su expresión con el tiempo.");
        }
        const matureReflectionInstructions = hasDate && age >= 42 ? `
            REGLA DE ORO PARA PERSONAS MADURAS (Más de 42 años): La Reflexión sobre la Transmutación
            Tu tarea es presentar las energías de la 1ª Etapa como **potenciales de transformación y puntos para la auto-reflexión**. Usa lenguaje condicional y preguntas inquisitivas.
            1.  **Reto 1 como Oportunidad:** Preséntalo como una oportunidad de forjar sabiduría. Pregunta: "Esa lucha arquetípica de la primera etapa ofrece la llave para una profunda sabiduría. ¿Sientes que esa experiencia te ha fortalecido de una manera única?".
            2.  **Talento 1 como Base:** Preséntalo como la herramienta principal entregada. Pregunta: "Ese don natural fue tu gran aliado. Hoy, ¿lo sientes como una maestría integrada, una base firme sobre la que te apoyas?".
            3.  **Objetivo 1 como Cimiento:** Preséntalo como el proyecto de construcción de cimientos. Pregunta: "Esa meta de juventud buscaba forjar una base sólida. ¿Sientes que ese cimiento te permite ahora construir con confianza hacia tu nuevo objetivo?".
        ` : '';
        return `
            Eres un numerólogo experto y coach espiritual. Tu tono es sabio, empoderador y profundamente respetuoso.
             // --- REGLA DE FORMATO ABSOLUTA ---
            EL TEXTO FINAL NO DEBE CONTENER NINGÚN ASTERISCO (*).
            NO USES NINGÚN TIPO DE FORMATO MARKDOWN. LA SALIDA DEBE SER 100% TEXTO PLANO.
            // ---------------------------------
            // --- REGLA MÁS IMPORTANTE DE TODAS ---
            REGLA INQUEBRANTABLE: NO ASUMIR NI INVENTAR LA HISTORIA PERSONAL
            Tu función más importante es describir la naturaleza arquetípica de cada energía (qué significa, qué retos y oportunidades presenta).
            1.  **PROHIBIDO INVENTAR:** Está estrictamente prohibido hacer suposiciones sobre las experiencias, acciones, pensamientos o emociones pasadas de la persona. NO uses frases como "Recuerdo tus años...", "Quizás sentiste...", "Probablemente hiciste...".
            2.  **ENFOQUE EN EL ARQUETIPO, NO EN LA BIOGRAFÍA:** En lugar de decir "tú te aferrabas al pasado", describe la energía: "La energía del karma 11-2 se manifiesta a menudo como una tendencia a aferrarse al pasado".
            3.  **INVITA, NO AFIRMES:** Presenta cada concepto como una invitación a la reflexión. El guion debe ser un mapa del mundo interior de la persona, no un relato de sus acciones pasadas.
            // --- FIN DE LA REGLA INQUEBRANTABLE ---
            FILOSOFÍA CLAVE DE LA NARRATIVA: MISIÓN EN CURSO
            Escribe desde la perspectiva de que la vida es un viaje en progreso. Usa un lenguaje que indique un camino continuo ("Eres llamado a...", "Tu camino te invita a...") y un tono humilde y alentador.
            ${matureReflectionInstructions}
            REGLAS IMPORTANTES:
            1.  FORMATO DE ENERGÍAS: Al mencionar una energía como '8-8', escríbela siempre sin guion: '8 8'.
            Datos de la Persona:
            - Nombre: ${rawData.name}
            - Edad: ${rawData.age ? rawData.age + ' años' : 'Desconocida'}
            - Género: ${rawData.gender}
            Instrucciones de Narrativa y Estructura:
            - Adaptacion por Edad: ${ageInstructions}
            - Saludo: Comienza con "Querida [Nombre]," o "Querido [Nombre],".
            Material Base (Describe el significado de estas energías):
           - Misión de Vida (${rawData.mission.code}): Esta misión tiene una dualidad clave. Su potencial y luz se describen así: '${rawData.mission.text}'. **El reto de encarnar esta misión** es aprender a transmutar esta sombra: '${rawData.mission.challengeText}'. **IMPORTANTE: Al describir este reto, NO uses la palabra 'karma'. Refiérete a él como 'el reto de tu misión' o 'el aprendizaje de esta energía'.**
            - Esencia (${rawData.esencia.code}): ${rawData.esencia.text}
            - Karma o Reto de la 1ª Etapa (${rawData.karma1.code}): ${rawData.karma1.text}
            - Talento o Don a activar de la 1ª Etapa (${rawData.talent1.code}): ${rawData.talent1.text}
            - Objetivo o Área donde enfocarse de la 1ª Etapa (${rawData.goal1.code}): ${rawData.goal1.text}
            - Karma o Reto de la 2ª Etapa (${rawData.karma2.code}): ${rawData.karma2.text}
            - Talento o Don a activar de la 2ª Etapa (${rawData.talent2.code}): ${rawData.talent2.text}
            - Objetivo o Área donde enfocarse de la 2ª Etapa (${rawData.goal2.code}): ${rawData.goal2.text}
            - Aprendizaje o Reto Transversal de Vida (${rawData.learning.code}): ${rawData.learning.text}
            - Matiz de Misión o 'Gran Misión' (${rawData.mission2.code}): Esta es la energía de culminación. Su significado base es: '${rawData.mission2.text}'.${rawData.learning.code !== 'N/A' ? ` **REGLA INQUEBRANTABLE PARA ESTE PUNTO:** Al redactar el párrafo final sobre esta energía, DEBES explicarla explícitamente como el resultado de la integración de la 'Misión de Vida' (${rawData.mission.code}) y el 'Aprendizaje Transversal' (${rawData.learning.code}). NO la presentes como un concepto aislado.` : ''}
            Matices Adicionales:
            ${holisticInsights.map(insight => `- ${insight}`).join('\n')}
            Instrucción Final: Tu tarea es generar un guion narrativo EXTENSO y DETALLADO, como si fuera una meditación guiada sobre el plan del alma de la persona. Tu objetivo principal es expandir y dar vida a los textos base que te he proporcionado. No resumas en exceso; al contrario, profundiza. Utiliza las metáforas, imágenes y el lenguaje evocador específico de cada descripción para crear una experiencia inmersiva. Conecta las diferentes energías de forma fluida, manteniendo siempre un tono de sabio mentor que equilibra la visión espiritual elevada con reflexiones y preguntas que inviten a la persona a aplicar estos arquetipos en su día a día. El guion resultante debe ser significativamente más rico y largo que los textos del informe PDF, empoderando a la persona con una claridad y profundidad aún mayores para el camino que continúa.
            INSTRUCCIÓN PARA EL PÁRRAFO DE CIERRE FINAL:
Después de haber explicado la 'Gran Misión' y su integración, escribe un último párrafo de cierre, separado del anterior. Este párrafo final debe ser breve pero muy poderoso y poético. No introduzcas nuevas energías ni conceptos. Su único propósito es servir como una bendición final o un mensaje de empoderamiento, resumiendo la belleza del viaje del alma de la persona y animándola a caminar con confianza, sabiduría y la paz que nace del autoconocimiento. Usa un lenguaje elevado y emotivo para el cierre.
        `;
    }
}, [plan]);

    const handleGenerateAudioScript = useCallback(async () => {
    if (!plan) return;
    setIsPolishing(true);
    setReviewMessage('Creando guion artístico...');
    try {
        let finalScript;
        if (targetLanguage === 'Español (original)') {
            setReviewMessage('Generando guion en castellano...');
            const spanishPrompt = await getOriginalSpanishPrompt(plan);
            const payload = { contents: [{ role: "user", parts: [{ text: spanishPrompt }] }] };
            const result = await callGeminiWithBackoff(payload);
            finalScript = result.candidates?.[0]?.content?.parts?.[0]?.text;
        } else {
            setReviewMessage('Paso 1/2: Creando narrativa base en castellano...');
            const spanishBasePrompt = await getOriginalSpanishPrompt(plan);
            const basePayload = { contents: [{ role: "user", parts: [{ text: spanishBasePrompt }] }] };
            const baseResult = await callGeminiWithBackoff(basePayload);
            const spanishBaseScript = baseResult.candidates?.[0]?.content?.parts?.[0]?.text;
            if (!spanishBaseScript || spanishBaseScript.trim() === "") {
                throw new Error("La narrativa base en castellano no se pudo generar o vino vacía.");
            }
            setReviewMessage(`Paso 2/2: Traduciendo a ${targetLanguage} con alta fidelidad...`);
            const translationPrompt = `
                Eres un traductor profesional experto, especializado en textos espirituales y de coaching.
                Tu única tarea es traducir el siguiente texto del español al idioma "${targetLanguage}".
                **REGLAS ESTRICTAS DE TRADUCIÓN:**
                1.  **FIDELIDAD ABSOLUTA:** La traducción debe ser extremadamente fiel al contenido original. **NO omitas, resumas ni alteres ninguna información, energía o número.**
                2.  **CONSERVACIÓN DEL TONO:** Debes conservar perfectamente el tono cálido, personal, sabio y poético del original.
                3.  **NATURALIDAD NATIVA:** El resultado final debe sonar 100% natural y fluido para un hablante nativo de "${targetLanguage}".
                **TEXTO A TRADUCIR:**
                ---
                ${spanishBaseScript}
                ---
            `;
            const finalPayload = { contents: [{ role: "user", parts: [{ text: translationPrompt }] }] };
            const finalResult = await callGeminiWithBackoff(finalPayload);
            finalScript = finalResult.candidates?.[0]?.content?.parts?.[0]?.text;
        }
        if (!finalScript) {
            throw new Error("El guion final no se pudo generar.");
        }
        setAudioScript(finalScript);
        setIsAudioModalOpen(true);
        setReviewMessage('Guion artístico generado con éxito.');
    } catch (err) {
        console.error('Error al generar el guion con IA:', err);
        const userFriendlyMessage = err.message.includes('503') ? 'El servicio está temporalmente sobrecargado. Se reintentará automáticamente en unos minutos.' : `Error: ${err.message}`;
        setReviewMessage(userFriendlyMessage);
    } finally {
        setIsPolishing(false);
        setTimeout(() => setReviewMessage(''), 7000);
    }
}, [plan, targetLanguage, getOriginalSpanishPrompt]);

    const memoizedFormatText = useCallback((text = "") => text.split('\n').map((str, i) => <React.Fragment key={i}>{str}{i < text.split('\n').length - 1 && <br />}</React.Fragment>), []);
    if (!processedTexts) return <div className="text-center p-10">Procesando informe...</div>;
    const firstName = plan.NOMBRE_COMPLETO ? plan.NOMBRE_COMPLETO.split(' ')[0] : (plan.isDeceased ? 'Esta alma' : 'Amigo/a');
    const introQuoteText = (processedTexts.INTRO_QUOTE || "").replace(/{firstName}/g, firstName);
    const chartLabels = {
        CHART_LABEL_MISION: processedTexts.CHART_LABEL_MISION, CHART_LABEL_OBJETIVO_I: processedTexts.CHART_LABEL_OBJETIVO_I,
        CHART_LABEL_OBJETIVO_II: processedTexts.CHART_LABEL_OBJETIVO_II, CHART_LABEL_KARMA_I: processedTexts.CHART_LABEL_KARMA_I,
        CHART_LABEL_KARMA_II: processedTexts.CHART_LABEL_KARMA_II, CHART_LABEL_TALENTO_I: processedTexts.CHART_LABEL_TALENTO_I,
        CHART_LABEL_TALENTO_II: processedTexts.CHART_LABEL_TALENTO_II, CHART_LABEL_OBJETIVOS_CORTOS: processedTexts.CHART_LABEL_OBJETIVOS_CORTOS,
        CHART_LABEL_KARMA_CORTOS: processedTexts.CHART_LABEL_KARMA_CORTOS, CHART_LABEL_TALENTOS_CORTOS: processedTexts.CHART_LABEL_TALENTOS_CORTOS,
        CHART_LABEL_MISION_2: processedTexts.CHART_LABEL_MISION_2, CHART_LABEL_APRENDIZAJE: processedTexts.CHART_LABEL_APRENDIZAJE,
        CHART_LABEL_ESENCIA: processedTexts.CHART_LABEL_ESENCIA,
    };

    return (
        <>
           <style>{`.report-container{font-family:'Lato',Arial,sans-serif;color:#222;font-size:16px;line-height:1.6;padding-bottom:2rem;overflow-y:visible!important;height:auto!important}.report-title{font-size:2.1rem;font-weight:700;letter-spacing:.01em;margin-bottom:.5rem;color:#4361ee;page-break-inside:avoid}.report-subtitle{font-size:1.15rem;color:#868686;margin-bottom:4px}.report-user-info{font-size:1rem;color:#525252;margin-bottom:10px;margin-top:6px}.report-header{border-bottom:2px solid #ececec;padding-bottom:14px;margin-bottom:18px;page-break-inside:avoid}.report-intro{font-size:1.1rem;margin-bottom:24px;color:#393939}.report-quote{background:#e7f0fd;border-left:5px solid #4361ee;margin:24px 0;padding:16px 26px;border-radius:10px;font-size:1.08rem;font-style:italic;color:#31416b;page-break-inside:avoid;break-inside:avoid-page;orphans:3;widows:3}.report-h2{color:#4361ee;font-size:1.5rem;margin-top:30px;margin-bottom:12px;letter-spacing:.01em;font-weight:700;border-bottom:1px solid #e0e0e0;padding-bottom:8px;page-break-inside:avoid;page-break-after:avoid}.report-h3{color:#31416b;font-size:1.2rem;font-weight:700;margin-top:20px;margin-bottom:8px;page-break-inside:avoid;page-break-after:avoid}.report-section{margin-bottom:24px;text-align:justify;page-break-inside:avoid;break-inside:avoid-page;}.report-section p{orphans:3;widows:3;}.report-highlight{background:#f1f8fe;border-radius:8px;padding:16px 22px;margin:24px 0;font-weight:400;color:#31416b;border:1px solid #e7f0fd;page-break-inside:avoid}.report-footer{text-align:center;margin-top:32px;padding-top:24px;page-break-inside:avoid!important}.report-link{color:#4361ee;text-decoration:underline;font-weight:700}.report-link-highlight{background-color:#fff799;padding:2px 4px;border-radius:3px}.no-underline{text-decoration:none!important}.report-energy-value{color:#ef4444;font-weight:700;margin-left:8px;margin-right:4px;display:inline-block}@media print{.no-print{display:none!important}}`}</style>
            <div className="bg-white p-6 sm:p-8 rounded-xl shadow-lg">
                <div ref={buttonsContainerRef} className="flex flex-col sm:flex-row justify-between items-start mb-6 no-print gap-4">
                    <h2 className="text-2xl font-bold text-gray-700">Informe Generado</h2>
                    <div className="flex flex-wrap items-center gap-2">
                        <button onClick={onNew} className="flex items-center gap-2 bg-green-500 text-white font-bold py-2 px-4 rounded-lg hover:bg-green-600"><IconPlus />Crear Nuevo</button>
                        <select value={targetLanguage} onChange={(e) => setTargetLanguage(e.target.value)} className="bg-gray-50 border border-gray-300 text-gray-900 text-sm rounded-lg p-2">
                            <option>Español (original)</option><option>English (USA)</option><option>Français</option><option>Italiano</option><option>Português</option><option>Deutsch</option><option>Català</option><option>Lietuvių</option>
                        </select>
                        <button onClick={handleAIPolish} disabled={isPolishing} className="flex items-center gap-2 bg-purple-500 text-white font-bold py-2 px-4 rounded-lg hover:bg-purple-600 disabled:bg-gray-400"><IconSparkles />{isPolishing ? 'Puliendo...' : 'Pulir con IA'}</button>
                        <button onClick={handleCopyReport} className="bg-gray-200 text-gray-800 font-bold py-2 px-4 rounded-lg hover:bg-gray-300 transition-colors">{copyButtonText}</button>
                        <button onClick={handleGenerateAudioScript} className="flex items-center gap-2 bg-cyan-500 text-white font-bold py-2 px-4 rounded-lg hover:bg-cyan-600"><IconSoundWave />Generar Guión para Audio</button>
                        <button onClick={handleGenerateYearlyCoachingScript} disabled={isPolishing} className="flex items-center gap-2 bg-orange-500 text-white font-bold py-2 px-4 rounded-lg hover:bg-orange-600 disabled:bg-gray-400"><svg aria-hidden="true" focusable="false" xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 22h14"/><path d="M5 2h14"/><path d="M17 22v-4.172a2 2 0 0 0-.586-1.414L12 12l-4.414 4.414A2 2 0 0 0 7 17.828V22"/><path d="M7 2v4.172a2 2 0 0 0 .586 1.414L12 12l4.414-4.414A2 2 0 0 0 17 6.172V2"/></svg>Guía Anual</button>
                        <button onClick={handleExportPDF} disabled={!isPdfReady} className="flex items-center gap-2 bg-red-500 text-white font-bold py-2 px-4 rounded-lg hover:bg-red-600 disabled:bg-gray-400"><IconPDF />{isPdfReady ? 'Exportar a PDF' : 'Cargando...'}</button>
                    </div>
                </div>
                {reviewMessage && <div className="mb-4 text-center text-green-700 font-semibold bg-green-100 p-2 rounded-lg">{reviewMessage}</div>}
                <div ref={reportElementRef} className="report-container bg-white p-4 sm:p-8 md:p-12 border border-gray-200 rounded-lg">
                    <header className="report-header">
                        <h2 ref={reportTitleRef} tabIndex={-1} className="report-title outline-none">{processedTexts.TITLE_MAIN}</h2>
                        <p className="report-subtitle">{plan.NOMBRE_COMPLETO} &nbsp;|&nbsp; {plan.hasDate ? plan.FECHA_NACIMIENTO : processedTexts.LABEL_FECHA_DESCONOCIDA}</p>
                        <p className="report-user-info">{processedTexts.SUBTITLE_ELABORADO}</p>
                        <p className="report-user-info mt-3 mb-0"><a href={guideUrl} target="_blank" rel="noopener noreferrer" className="report-link report-link-highlight">{processedTexts.LINK_GUIA}</a></p>
                    </header>
                    <EnergyChartSVG energies={plan.energies} isShortName={plan.isShortName} hasDate={plan.hasDate} labels={chartLabels} />
                    <div className="report-quote" dangerouslySetInnerHTML={{ __html: introQuoteText }} />
                    <section className="report-section"><h2 className="report-h2">{processedTexts.H2_KARMA}</h2><h3 className="report-h3">{processedTexts.H3_KARMA_1}<span className="report-energy-value">{plan.energies.pk}</span></h3><p>{memoizedFormatText(processedTexts.ANÁLISIS_KARMA_1)}</p><h3 className="report-h3">{processedTexts.H3_KARMA_2}<span className="report-energy-value">{plan.energies.sk}</span></h3><p>{memoizedFormatText(processedTexts.ANÁLISIS_KARMA_2)}</p></section>
                    <section className="report-section"><h2 className="report-h2">{processedTexts.H2_TALENTOS}</h2><h3 className="report-h3">{processedTexts.H3_TALENTO_1}<span className="report-energy-value">{plan.energies.pt}</span></h3><p>{memoizedFormatText(processedTexts.ANÁLISIS_TALENTO_1)}</p><h3 className="report-h3">{processedTexts.H3_TALENTO_2}<span className="report-energy-value">{plan.energies.st}</span></h3><p>{memoizedFormatText(processedTexts.ANÁLISIS_TALENTO_2)}</p></section>
                    <section className="report-section"><h2 className="report-h2">{processedTexts.H2_OBJETIVOS}</h2><h3 className="report-h3">{processedTexts.H3_OBJETIVO_1}<span className="report-energy-value">{plan.energies.pg}</span></h3><p>{memoizedFormatText(processedTexts.ANÁLISIS_OBJETIVO_1)}</p><h3 className="report-h3">{processedTexts.H3_OBJETIVO_2}<span className="report-energy-value">{plan.energies.sg}</span></h3><p>{memoizedFormatText(processedTexts.ANÁLISIS_OBJETIVO_2)}</p></section>
                    <section className="report-section"><h2 className="report-h2">{processedTexts.H2_MISION_VITAL}<span className="report-energy-value">{plan.energies.soulDestiny}</span></h2><p>{memoizedFormatText(processedTexts.ANÁLISIS_MISIÓN_PERSONALIZADO)}</p><h3 className="report-h3 mt-8">{processedTexts.H3_ESENCIA}<span className="report-energy-value">{plan.energies.esencia}</span></h3><p>{memoizedFormatText(processedTexts.ANÁLISIS_ESENCIA)}</p>{plan.hasDate && (<><h3 className="report-h3">{processedTexts.H3_MISION_2}<span className="report-energy-value">{plan.energies.mision2}</span></h3><p>{memoizedFormatText(processedTexts.ANÁLISIS_MISIÓN_2)}</p><h3 className="report-h3">{processedTexts.H3_APRENDIZAJE}<span className="report-energy-value">{plan.energies.aprendizaje}</span></h3><p>{memoizedFormatText(processedTexts.ANÁLISIS_APRENDIZAJE)}</p></>)}</section>
                    <section className="report-section report-highlight"><h2 className="report-h2 border-none mt-0">{processedTexts.H2_SINTESIS}</h2><p>{memoizedFormatText(processedTexts.SÍNTESIS)}</p></section>
                    <section className="report-section report-highlight"><h2 className="report-h2 border-none mt-0">{processedTexts.H2_EXPANSION}</h2><p>{memoizedFormatText(processedTexts.ÁREAS_DE_EXPANSIÓN)}</p></section>
                    <FinalQuote template={processedTexts.FINAL_QUOTE} firstName={firstName} gender={plan.gender} isDeceased={plan.isDeceased} />
                    <footer className="report-footer"><a href={footerUrl} target="_blank" rel="noopener noreferrer" className="inline-block bg-gradient-to-r from-orange-500 to-red-500 text-white font-bold text-lg py-3 px-8 rounded-full shadow-lg hover:shadow-xl transform-gpu hover:-translate-y-1 transition-all duration-300 no-underline">{processedTexts.FOOTER_LINK}</a></footer>
                </div>
                {isAudioModalOpen && <AudioScriptModal script={audioScript} onClose={() => setIsAudioModalOpen(false)} targetLanguage={targetLanguage} planName={plan.NOMBRE_COMPLETO} />}
            </div>
        </>
    );
});
// Lazy load del componente de informe para un mejor rendimiento inicial.
const PlanReport = React.lazy(() => Promise.resolve({ default: PlanReportComponent }));

/**
 * Muestra la lista de planes guardados desde Firestore.
 */
const SavedPlansList = memo(({ plans, onView, onDelete, activePlanId, isLoading }) => {
    const sortedPlans = useMemo(() => {
        return [...plans].sort((a, b) => {
            const aMs = a.createdAt?.toDate?.()?.getTime?.() ?? a.createdAtClient ?? 0;
            const bMs = b.createdAt?.toDate?.()?.getTime?.() ?? b.createdAtClient ?? 0;
            if (a.__pending && !b.__pending) return -1;
            if (!a.__pending && b.__pending) return 1;
            return bMs - aMs;
        });
    }, [plans]);

return (
        <div className="bg-white p-6 rounded-xl shadow-lg">
            <h3 className="text-xl font-bold text-gray-700 mb-4">Planes Guardados</h3>
            <div aria-busy={isLoading}>
                {isLoading ? <div className="text-center text-gray-500">Cargando planes...</div>
                : plans.length === 0 ? <div className="text-center text-gray-500 bg-gray-50 p-4 rounded-lg">Aún no has guardado ningún plan.</div>
                : (
                    <ul className="space-y-3">
                        {sortedPlans.map(plan => (
                            <li key={plan.id} onClick={() => onView(plan)} className={`p-3 rounded-lg cursor-pointer transition-all duration-200 flex justify-between items-center ${activePlanId === plan.id ? 'bg-blue-100 border-blue-400 border' : 'bg-gray-50 hover:bg-gray-100'}`}>
                                <div>
                                    <p className="font-semibold text-gray-800">{plan.NOMBRE_COMPLETO}</p>
                                    <p className="text-sm text-gray-500">{plan.FECHA_NACIMIENTO || 'Sin fecha'}</p>
                                </div>
                                <button onClick={(e) => {e.stopPropagation(); onDelete(plan.id);}} className="text-red-500 hover:text-red-700 p-1 rounded-full hover:bg-red-100" aria-label={`Eliminar plan de ${plan.NOMBRE_COMPLETO}`}><IconTrash /></button>
                            </li>
                        ))}
                    </ul>
                )}
            </div>
        </div>
    );
});

// =================================================================================
// === COMPONENTE PRINCIPAL Y LÓGICA DE LA APLICACIÓN ==============================
// =================================================================================

function LifePlanApp({ isPdfReady }) {
    const [view, setView] = useState('form'); // 'form' | 'report'
    const [currentPlan, setCurrentPlan] = useState(null);
    const [savedPlans, setSavedPlans] = useState([]);
    const [isLoading, setIsLoading] = useState(true);
    const [isCalculating, setIsCalculating] = useState(false);
    const [error, setError] = useState('');
    const { db, userId, appId } = useFirebase();
    
    // --- Carga previa de textos de análisis desde Firestore ---
    const [textsFromDb, setTextsFromDb] = useState(null);
    const [textsLoadState, setTextsLoadState] = useState('loading'); // 'loading' | 'success' | 'error'
    const [textsError, setTextsError] = useState('');

    const preloadAnalysisTexts = useCallback(async () => {
        setTextsLoadState('loading');
        setTextsError('');
        try {
            const data = await getAnalysisTexts();
            setTextsFromDb(data);
            setTextsLoadState('success');
        } catch (e) {
            setTextsError(e?.message || 'Error cargando textos desde Firestore.');
            setTextsLoadState('error');
        }
    }, []);

    useEffect(() => {
        preloadAnalysisTexts();
    }, [preloadAnalysisTexts]);
const reportTitleRef = useRef(null);
    
    useEffect(() => {
        if (!userId || !db || !appId) return;
        const plansCollectionPath = collection(db, 'artifacts', appId, 'users', userId, 'life_plans');
        const q = query(plansCollectionPath, limit(APP_CONFIG.MAX_SAVED_PLANS));
        const unsubscribe = onSnapshot(q, (snapshot) => {
            const plans = snapshot.docs.map(doc => ({ id: doc.id, __pending: doc.metadata.hasPendingWrites, ...doc.data() }));
            setSavedPlans(plans);
            setIsLoading(false);
        }, (err) => {
            console.error("Error al obtener los planes:", err);
            setError("No se pudieron cargar los planes guardados.");
            setIsLoading(false);
        });
        return unsubscribe;
    }, [userId, db, appId]);

    useEffect(() => {
        if (view === 'report' && reportTitleRef.current) {
            reportTitleRef.current.focus();
        }
    }, [view]);

    const handleGeneratePlan = useCallback(async ({ name, day, month, year, gender, isDeceased }) => {
        setError('');
        setIsCalculating(true);
        try {
            const calculatedData = await calculationEngine.calculatePlan(textsFromDb, name, day, month, year, gender, isDeceased);
            if (!calculatedData) {
                throw new Error("No se pudo calcular el plan. Revisa el nombre introducido.");
            }
            const now = new Date();
            const planData = { ...calculatedData, createdAt: serverTimestamp(), createdAtClient: now.getTime() };
            const plansCollectionPath = collection(db, 'artifacts', appId, 'users', userId, 'life_plans');
            const docRef = await addDoc(plansCollectionPath, planData);
            setCurrentPlan({ id: docRef.id, ...planData });
            setView('report');
        } catch (e) {
            console.error("Error al añadir el documento: ", e);
            setError(e.message || "Hubo un error al guardar el plan.");
        } finally {
            setIsCalculating(false);
        }
    }, [userId, db, appId]);

    const handleDeletePlan = useCallback(async (planId) => {
        if (!userId || !planId || !db || !appId) return;
        try {
    const planDocPath = doc(db, 'artifacts', appId, 'users', userId, 'life_plans', planId);
    await deleteDoc(planDocPath);
    if (currentPlan?.id === planId) {
        setView('form');
        setCurrentPlan(null);
    }
} catch (error) {
    console.error("Error al eliminar el documento: ", error);
    setError("No se pudo eliminar el plan.");
}
    }, [userId, db, appId, currentPlan?.id]);

    const handleViewPlan = useCallback((plan) => {
        setCurrentPlan(plan);
        setView('report');
    }, []);

    const handleCreateNew = useCallback(() => {
        setCurrentPlan(null);
        setView('form');
        setError('');
    }, []);


    if (textsLoadState === 'loading') {
        return (
            <div className="min-h-screen flex items-center justify-center bg-slate-950 text-slate-100">
                <div className="p-8 rounded-xl border border-slate-800 bg-slate-900 shadow-xl text-center">
                    <div className="mb-3 font-semibold text-lg">Cargando textos de análisis…</div>
                    <div className="text-slate-400">Conectando con Firestore y preparando la aplicación.</div>
                </div>
            </div>
        );
    }
    if (textsLoadState === 'error') {
        return (
            <div className="min-h-screen flex items-center justify-center bg-slate-950 text-slate-100">
                <div className="p-8 rounded-xl border border-red-800/40 bg-red-950/40 shadow-xl text-center">
                    <div className="mb-2 font-semibold text-lg">Error al cargar los textos</div>
                    <div className="mb-4 text-red-200">{textsError}</div>
                    <button onClick={preloadAnalysisTexts} className="px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-500">
                        Reintentar
                    </button>
                </div>
            </div>
        );
    }
return (
        <div className="bg-gray-100 min-h-screen font-sans text-gray-800">
            <header className="bg-white shadow-sm">
                <div className="container mx-auto px-4 sm:px-6 lg:px-8 py-4 flex justify-between items-center">
                    <h1 className="text-2xl font-bold text-blue-600">Asistente de Plan de Vida</h1>
                    {userId && (<div className="text-xs text-gray-500 text-right"><p>ID de Usuario:</p><p className="font-mono">{userId}</p></div>)}
                </div>
            </header>
            <main className="p-4 sm:p-6 lg:p-8">
                <div className="container mx-auto grid grid-cols-1 lg:grid-cols-3 gap-8">
                    <div className="lg:col-span-2">
                        {view === 'form' && <PlanForm onSubmit={handleGeneratePlan} error={error} setError={setError} isCalculating={isCalculating} />}
                        {view === 'report' && currentPlan && (
                            <ErrorBoundary>
                                <Suspense fallback={<div className="text-center p-10">Cargando informe...</div>}>
                                    <PlanReport plan={currentPlan} onNew={handleCreateNew} isPdfReady={isPdfReady} reportTitleRef={reportTitleRef} />
                                </Suspense>
                            </ErrorBoundary>
                        )}
                    </div>
                    <aside className="lg:col-span-1">
                        <SavedPlansList plans={savedPlans} onView={handleViewPlan} onDelete={handleDeletePlan} activePlanId={currentPlan?.id} isLoading={isLoading} />
                    </aside>
                </div>
            </main>
        </div>
    );
}

// =================================================================================
// === PUNTO DE ENTRADA DE LA APLICACIÓN ===========================================
// =================================================================================

export default function App() {
    const [isPdfReady, setIsPdfReady] = useState(false);

    useEffect(() => {
        const scriptId = 'html2pdf-script';
        if (document.getElementById(scriptId)) {
            setIsPdfReady(true);
            return;
        }
        const script = document.createElement('script');
        script.id = scriptId;
        script.src = "https://cdnjs.cloudflare.com/ajax/libs/html2pdf.js/0.10.1/html2pdf.bundle.min.js";
        script.async = true;
        script.onload = () => setIsPdfReady(true);
        document.body.appendChild(script);
        return () => {
            document.getElementById(scriptId)?.remove();
        };
    }, []);

    return (
        <FirebaseProvider>
            <LifePlanApp isPdfReady={isPdfReady} />
        </FirebaseProvider>
    );
}
