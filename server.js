// ============================================================================
//  ALIPAFRIC — Recharge Alipay depuis le Togo (F CFA -> RMB)
//  ----------------------------------------------------------------------
//  Design inspiré d'une maquette fournie : thème sombre, accents bleu/jaune.
//  Toujours ultra léger : Express + fichiers JSON locaux + PDFKit.
// ============================================================================

require('dotenv').config();

const axios = require('axios');
const express = require("express");
const fs = require("fs");
const path = require('path');
const crypto = require("crypto");
const multer = require("multer");
const PDFDocument = require("pdfkit");
const { MongoClient } = require("mongodb");
const cloudinary = require("cloudinary").v2;
const archiver = require("archiver");
const webpush = require("web-push");

// 1. Déclarer l'application Express UNE SEULE FOIS
const app = express();

// Filet de sécurité : une erreur oubliée quelque part ne doit jamais faire
// planter tout le serveur (les versions récentes de Node.js arrêtent le
// process par défaut sur une promesse rejetée non gérée).
process.on("unhandledRejection", (raison) => {
  console.error("⚠️  Promesse rejetée non gérée :", raison);
});
process.on("uncaughtException", (erreur) => {
  console.error("⚠️  Exception non rattrapée :", erreur);
});

// 2. Servir le dossier public
app.use(express.static(path.join(__dirname, 'public')));

// Route simple pour garder le serveur éveillé avec UptimeRobot
app.get('/ping', (req, res) => {
  res.status(200).send('OK');
});

// ============================================================================
// FONCTIONS D'ENVOI D'E-MAILS
// (la fonction envoyerEmail elle-même — celle qui appelle Brevo — est
// définie plus bas dans ce fichier, juste avant le démarrage du serveur ;
// grâce au "hoisting" de JavaScript, elle est bien disponible ici aussi.)
// ============================================================================

async function envoyerEmailBienvenue(email, pseudo) {
  const sujet = `Bienvenue sur ${CONFIG.NOM_SITE} !`;
  const contenuHtml = `
    <h2>Bienvenue ${pseudo} !</h2>
    <p>Votre compte a été créé avec succès sur <b>${CONFIG.NOM_SITE}</b>.</p>
    <p>Vous pouvez dès à présent effectuer vos demandes de recharge Alipay en toute sécurité.</p>
  `;
  return envoyerEmail(email, sujet, contenuHtml);
}

async function envoyerEmailConfirmationInscription(email, code) {
  const sujet = `Confirmez votre e-mail — ${CONFIG.NOM_SITE}`;
  const contenuHtml = `
    <h2>Code de confirmation</h2>
    <p>Voici votre code pour confirmer votre adresse e-mail : <b style="font-size:20px; color:#2563EB;">${code}</b></p>
    <p>Saisissez ce code sur le site pour activer votre compte.</p>
  `;
  return envoyerEmail(email, sujet, contenuHtml);
}

// envoyerEmailReinitialisation est définie plus bas, juste à côté de la
// route /mot-de-passe-oublie qui l'utilise.

async function envoyerEmailTransaction(email, sujet, message) {
  const contenuHtml = `
    <h2>Mise à jour de votre transaction</h2>
    <p>${message}</p>
    <hr>
    <p><small>Connectez-vous à votre espace client sur ${CONFIG.NOM_SITE} pour plus de détails.</small></p>
  `;
  return envoyerEmail(email, sujet, contenuHtml);
}
// ===================================================

// ----------------------------------------------------------------------------
// 1) CONFIGURATION
// ----------------------------------------------------------------------------
const CONFIG = {
  NOM_SITE: "AlipAfric",
  TAGLINE: "RECHARGE. SIMPLIFIÉ.",
  // Grille tarifaire par palier : plus le client commande, plus le taux est
  // avantageux. "seuilMax" = montant RMB maximum pour bénéficier de ce taux.
  PALIERS_TAUX: [
    { seuilMax: 99.99, taux: 95 },
    { seuilMax: 999.99, taux: 93 },
    { seuilMax: Infinity, taux: 92 },
  ],
  MONTANT_MIN_RMB: 50,
  FRAIS_POURCENT: 0, // Frais de service désactivés
  PORT: process.env.PORT || 3000,

  // ⚠️ Changez ces identifiants avant de mettre le site en ligne.
  // ⚠️ Identifiants admin : définis dans le fichier .env (jamais dans ce fichier).
  // Voir ADMIN_IDENTIFIANT et ADMIN_MOT_DE_PASSE dans .env — valeurs de secours
  // ci-dessous UNIQUEMENT pour que le site démarre si .env n'est pas configuré.
  ADMIN_IDENTIFIANT: process.env.ADMIN_IDENTIFIANT || "admin",
  ADMIN_MOT_DE_PASSE: process.env.ADMIN_MOT_DE_PASSE || "ChangezMoi123!",

  CONTACT_EMAIL: "sherlockgroup1@gmail.com",
  NOM_TITULAIRE_COMPTE: "EDZI Hermann Christ",
  CONTACT_WHATSAPP: "22892908235",

  PAIEMENT: {
    mixx: { nom: "Mixx By Yas Togo", numero: "+228 92908235", logo: "mixx.png", noteFrais: true, typeSaisie: "telephone", togoUniquement: true },
    moov: { nom: "Moov Money Togo", numero: "+228 99248336", logo: "moov.png", noteFrais: true, typeSaisie: "telephone", togoUniquement: true },
    ecobank: { nom: "Ecobank Togo", numero: "141734798001", logo: "ecobank.jpg", noteFrais: false, typeSaisie: "nom", togoUniquement: false },
    pispi: { nom: "PI-SPI", numero: "+22892908235", logo: "pi.jpg", noteFrais: false, typeSaisie: "nom", togoUniquement: false },
  },
};

// Pays d'Afrique de l'Ouest utilisant le Franc CFA (XOF) — zone UEMOA.
// "chiffres" = nombre de chiffres attendu après l'indicatif (à ajuster si besoin).
const PAYS = [
  { indicatif: "+228", nom: "Togo", chiffres: 8 },
  { indicatif: "+229", nom: "Bénin", chiffres: 8 },
  { indicatif: "+226", nom: "Burkina Faso", chiffres: 8 },
  { indicatif: "+225", nom: "Côte d'Ivoire", chiffres: 10 },
  { indicatif: "+245", nom: "Guinée-Bissau", chiffres: 7 },
  { indicatif: "+223", nom: "Mali", chiffres: 8 },
  { indicatif: "+227", nom: "Niger", chiffres: 8 },
  { indicatif: "+221", nom: "Sénégal", chiffres: 9 },
];

const MESSAGE_REFUS_IDENTITE = "Soit nom différent à la pièce, soit pièce illisible.";
const MESSAGE_PAIEMENT_ANNULE = `Votre paiement a été annulé. Merci de nous contacter par e-mail (${CONFIG.CONTACT_EMAIL}) ou WhatsApp pour une prise en charge.`;

// ----------------------------------------------------------------------------
// 2) DOSSIERS ET FICHIERS DE STOCKAGE
// ----------------------------------------------------------------------------
const DOSSIER_UPLOADS_ALIPAY = path.join(__dirname, "uploads", "alipay");
const DOSSIER_UPLOADS_IDENTITE = path.join(__dirname, "uploads", "identite");
const DOSSIER_UPLOADS_PREUVES = path.join(__dirname, "uploads", "preuves");
const DOSSIER_FICHES = path.join(__dirname, "fiches"); // usage interne (admin)
const DOSSIER_RECUS = path.join(__dirname, "recus"); // reçu remis au client
const DOSSIER_LOGOS = path.join(__dirname, "public", "logos"); // logos des moyens de paiement
[DOSSIER_UPLOADS_ALIPAY, DOSSIER_UPLOADS_IDENTITE, DOSSIER_UPLOADS_PREUVES, DOSSIER_FICHES, DOSSIER_RECUS, DOSSIER_LOGOS].forEach((d) =>
  fs.mkdirSync(d, { recursive: true })
);

const FICHIER_UTILISATEURS = path.join(__dirname, "utilisateurs.json");
const FICHIER_TRANSACTIONS = path.join(__dirname, "transactions.json");
const FICHIER_NOTIFICATIONS = path.join(__dirname, "notifications.json");
const FICHIER_ABONNEMENTS_PUSH = path.join(__dirname, "abonnements-push.json");

// Association "chemin de fichier local" -> "nom de collection MongoDB".
// On garde les mêmes noms de constantes (FICHIER_UTILISATEURS, etc.) dans
// tout le reste du fichier pour ne pas avoir à toucher aux dizaines
// d'appels existants à sauvegarderJSON(FICHIER_X, tableauX).
const NOM_COLLECTION = {
  [FICHIER_UTILISATEURS]: "utilisateurs",
  [FICHIER_TRANSACTIONS]: "transactions",
  [FICHIER_NOTIFICATIONS]: "notifications",
  [FICHIER_ABONNEMENTS_PUSH]: "abonnementsPush",
};

// ----------------------------------------------------------------------------
// Stockage des données : MongoDB Atlas si MONGO_URI est configuré (données
// persistantes, survivent aux redéploiements), sinon fichiers JSON locaux
// (pratique pour du développement rapide en local, mais NON persistant sur
// un hébergeur comme Render).
// ----------------------------------------------------------------------------
const MONGO_URI = process.env.MONGO_URI;
let db = null;

// ----------------------------------------------------------------------------
// Stockage des fichiers uploadés (pièces d'identité, QR Alipay, preuves de
// paiement, PDF générés) : Cloudinary si configuré (persistant), sinon
// disque local (comme avant, non persistant sur Render).
// ----------------------------------------------------------------------------
const CLOUDINARY_ACTIF = !!(
  process.env.CLOUDINARY_CLOUD_NAME &&
  process.env.CLOUDINARY_API_KEY &&
  process.env.CLOUDINARY_API_SECRET
);
if (CLOUDINARY_ACTIF) {
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
  });
  console.log("✅ Cloudinary configuré — les fichiers uploadés sont persistants.");
} else {
  console.warn("⚠️  CLOUDINARY non configuré : les fichiers uploadés resteront sur le disque local (NON persistants sur Render). Voir .env.");
}

// ----------------------------------------------------------------------------
// Notifications push (PC + téléphone) pour l'admin : nouveau compte à
// vérifier, nouvelle preuve de paiement reçue.
// ----------------------------------------------------------------------------
const PUSH_ACTIF = !!(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY);
if (PUSH_ACTIF) {
  webpush.setVapidDetails(
    `mailto:${CONFIG.CONTACT_EMAIL}`,
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );
  console.log("✅ Notifications push configurées.");
} else {
  console.warn("⚠️  VAPID non configuré : pas de notifications push. Voir .env.");
}
let abonnementsPush = [];

async function envoyerNotificationPush(titre, corps, url) {
  if (!PUSH_ACTIF || abonnementsPush.length === 0) return;
  const charge = JSON.stringify({ titre, corps, url: url || "/admin" });
  const abonnementsValides = [];
  for (const abonnement of abonnementsPush) {
    try {
      await webpush.sendNotification(abonnement, charge);
      abonnementsValides.push(abonnement);
    } catch (erreur) {
      // 410/404 = abonnement expiré ou désinstallé, on l'oublie silencieusement.
      if (erreur.statusCode !== 410 && erreur.statusCode !== 404) {
        console.error("Erreur envoi notification push :", erreur.message);
        abonnementsValides.push(abonnement);
      }
    }
  }
  if (abonnementsValides.length !== abonnementsPush.length) {
    abonnementsPush = abonnementsValides;
    sauvegarderJSON(FICHIER_ABONNEMENTS_PUSH, abonnementsPush);
  }
}

async function connecterMongo() {
  if (!MONGO_URI) {
    console.warn("⚠️  MONGO_URI non défini : utilisation de fichiers JSON locaux (NON persistants sur Render). Voir .env.");
    return;
  }
  try {
    // family: 4 force la résolution DNS/connexion en IPv4. Sur certains
    // hébergeurs (dont Render), la connexion en IPv6 vers MongoDB Atlas
    // provoque une erreur "SSL alert number 80" — cette option la résout.
    const client = new MongoClient(MONGO_URI, { family: 4 });
    await client.connect();
    db = client.db(); // utilise le nom de base présent dans l'URI (ex : .../alipafric)
    console.log("✅ Connecté à MongoDB Atlas — les données sont persistantes.");
  } catch (erreur) {
    console.error("❌ Échec de connexion à MongoDB :", erreur.message);
    console.error("   Le site va démarrer avec des fichiers JSON locaux (non persistants) en attendant.");
  }
}

async function chargerJSON(cheminFichier) {
  if (db) {
    try {
      return await db.collection(NOM_COLLECTION[cheminFichier]).find({}).toArray();
    } catch (erreur) {
      console.error(`Erreur de lecture MongoDB (${NOM_COLLECTION[cheminFichier]}) :`, erreur.message);
      return [];
    }
  }
  try {
    return JSON.parse(fs.readFileSync(cheminFichier, "utf-8"));
  } catch (erreur) {
    return [];
  }
}
async function sauvegarderJSON(cheminFichier, donnees) {
  if (db) {
    try {
      const collection = db.collection(NOM_COLLECTION[cheminFichier]);
      await collection.deleteMany({});
      if (donnees.length > 0) await collection.insertMany(donnees);
    } catch (erreur) {
      console.error(`Erreur d'écriture MongoDB (${NOM_COLLECTION[cheminFichier]}) :`, erreur.message);
    }
    return;
  }
  fs.writeFileSync(cheminFichier, JSON.stringify(donnees, null, 2), "utf-8");
}

// Tableaux remplis au démarrage par demarrerServeur() (voir tout en bas du
// fichier), une fois la connexion MongoDB établie.
let utilisateurs = [];
let transactions = [];
let notifications = [];

function ajouterNotification(utilisateurId, message, reference) {
  notifications.push({
    id: crypto.randomUUID(),
    utilisateurId,
    message,
    reference,
    date: new Date().toISOString(),
    lu: false,
  });
  sauvegarderJSON(FICHIER_NOTIFICATIONS, notifications);
}

function genererReference() {
  return `AF-${Date.now().toString().slice(-6)}-${Math.floor(100 + Math.random() * 900)}`;
}
// Renvoie le taux F CFA/RMB applicable selon la grille tarifaire par palier
// (plus le montant commandé est élevé, plus le taux est avantageux).
function tauxPourMontant(montantRMB) {
  const palier = CONFIG.PALIERS_TAUX.find((p) => montantRMB <= p.seuilMax);
  return palier ? palier.taux : CONFIG.PALIERS_TAUX[CONFIG.PALIERS_TAUX.length - 1].taux;
}
// Génère le HTML de la grille tarifaire, affichable sur n'importe quelle page.
function grilleTarifaireHTML() {
  const lignes = CONFIG.PALIERS_TAUX
    .map((p, i) => {
      const min = i === 0 ? CONFIG.MONTANT_MIN_RMB : CONFIG.PALIERS_TAUX[i - 1].seuilMax + 0.01;
      const label = p.seuilMax === Infinity ? `${Math.ceil(min)} RMB et plus` : `${Math.ceil(min)} à ${Math.floor(p.seuilMax)} RMB`;
      return `<div class="ligne"><span>${label}</span><b>${p.taux} F CFA / Yuan</b></div>`;
    })
    .join("");
  return `<div class="carte"><h2 style="margin-bottom:4px;">Grille tarifaire</h2><p class="souligne" style="margin-bottom:10px;">Plus vous achetez, plus le taux baisse !</p>${lignes}</div>`;
}
// toLocaleString("fr-FR") insère une espace INSÉCABLE (U+202F) comme séparateur
// de milliers. La police par défaut de PDFKit ne l'affiche pas correctement
// (d'où le "9 /548" au lieu de "9 548"). On utilise donc une espace normale.
function formaterFCFA(nombre) {
  return Math.round(nombre)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, " ");
}
function genererPseudo() {
  let pseudo;
  do {
    pseudo = `Client${Math.floor(1000 + Math.random() * 9000)}`;
  } while (utilisateurs.some((u) => u.pseudo === pseudo));
  return pseudo;
}
function genererCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}
function nomAffichage(u) {
  return u.statutVerification === "verifie" && u.prenom ? u.prenom : u.pseudo;
}

// ----------------------------------------------------------------------------
// 3) MOTS DE PASSE ET SESSIONS
// ----------------------------------------------------------------------------
function hacherMotDePasse(motDePasse) {
  const sel = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(motDePasse, sel, 64).toString("hex");
  return { sel, hash };
}
function motDePasseCorrect(motDePasse, sel, hashAttendu) {
  const hash = crypto.scryptSync(motDePasse, sel, 64);
  const attendu = Buffer.from(hashAttendu, "hex");
  return hash.length === attendu.length && crypto.timingSafeEqual(hash, attendu);
}
// Au moins 8 caractères, 1 majuscule, 1 minuscule, 1 chiffre (caractères spéciaux permis mais pas obligatoires)
function motDePasseRobuste(mdp) {
  return /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d).{8,}$/.test(mdp);
}

const sessions = new Map(); // sessionId -> idUtilisateur
const sessionsAdmin = new Set(); // sessionId admin

function parseCookies(req) {
  const entete = req.headers.cookie;
  const resultat = {};
  if (!entete) return resultat;
  entete.split(";").forEach((paire) => {
    const index = paire.indexOf("=");
    if (index === -1) return;
    resultat[paire.slice(0, index).trim()] = decodeURIComponent(paire.slice(index + 1).trim());
  });
  return resultat;
}
function connecterUtilisateur(res, idUtilisateur) {
  const sessionId = crypto.randomUUID();
  sessions.set(sessionId, idUtilisateur);
  res.setHeader("Set-Cookie", `session=${sessionId}; HttpOnly; Path=/; SameSite=Lax`);
}
function deconnecterUtilisateur(req, res) {
  const cookies = parseCookies(req);
  if (cookies.session) sessions.delete(cookies.session);
  res.setHeader("Set-Cookie", "session=; HttpOnly; Path=/; Max-Age=0");
}
function connecterAdmin(res) {
  const sessionId = crypto.randomUUID();
  sessionsAdmin.add(sessionId);
  res.setHeader("Set-Cookie", `sessionAdmin=${sessionId}; HttpOnly; Path=/; SameSite=Lax`);
}
function deconnecterAdmin(req, res) {
  const cookies = parseCookies(req);
  if (cookies.sessionAdmin) sessionsAdmin.delete(cookies.sessionAdmin);
  res.setHeader("Set-Cookie", "sessionAdmin=; HttpOnly; Path=/; Max-Age=0");
}

// ----------------------------------------------------------------------------
// 4) MIDDLEWARES EXPRESS
// ----------------------------------------------------------------------------
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use("/uploads", express.static(path.join(__dirname, "uploads")));
app.use("/fiches", express.static(DOSSIER_FICHES));
app.use("/recus", express.static(DOSSIER_RECUS));
app.use("/logos", express.static(DOSSIER_LOGOS));

app.use((req, res, next) => {
  const cookies = parseCookies(req);
  const idUtilisateur = sessions.get(cookies.session);
  req.utilisateur = idUtilisateur ? utilisateurs.find((u) => u.id === idUtilisateur) : null;
  req.estAdmin = sessionsAdmin.has(cookies.sessionAdmin);
  next();
});

function exigerConnexion(req, res, next) {
  if (!req.utilisateur) return res.redirect("/connexion");
  if (req.utilisateur.compteSupprime) {
    deconnecterUtilisateur(req, res);
    return res.redirect("/connexion");
  }
  next();
}
function exigerEmailVerifie(req, res, next) {
  if (!req.utilisateur) return res.redirect("/connexion");
  if (!req.utilisateur.emailVerifie) return res.redirect("/confirmer-email");
  next();
}
function exigerAdmin(req, res, next) {
  if (!req.estAdmin) return res.redirect("/admin/connexion");
  next();
}

function creerUpload(dossierDestination, typesAutorises, tailleMaxOctets) {
  // Si Cloudinary est configuré, on garde les fichiers en mémoire (buffer) le
  // temps de les envoyer vers Cloudinary. Sinon, comportement historique :
  // écriture directe sur le disque local (NON persistant sur Render).
  const stockage = CLOUDINARY_ACTIF
    ? multer.memoryStorage()
    : multer.diskStorage({
        destination: (req, file, cb) => cb(null, dossierDestination),
        filename: (req, file, cb) => {
          const extension = path.extname(file.originalname) || ".jpg";
          cb(null, `${Date.now()}-${Math.floor(Math.random() * 1000)}${extension}`);
        },
      });
  return multer({
    storage: stockage,
    limits: { fileSize: tailleMaxOctets },
    fileFilter: (req, file, cb) => {
      if (!typesAutorises || typesAutorises.includes(file.mimetype)) return cb(null, true);
      cb(new Error("Format non autorisé. Utilisez JPG, JPEG, PNG ou PDF."));
    },
  });
}
const uploadAlipay = creerUpload(DOSSIER_UPLOADS_ALIPAY, ["image/jpeg", "image/png", "image/jpg"], 2 * 1024 * 1024);
const uploadIdentite = creerUpload(
  DOSSIER_UPLOADS_IDENTITE,
  ["image/jpeg", "image/png", "image/jpg", "application/pdf"],
  2 * 1024 * 1024
);
const uploadPreuve = creerUpload(
  DOSSIER_UPLOADS_PREUVES,
  ["image/jpeg", "image/png", "image/jpg", "application/pdf"],
  2 * 1024 * 1024
);

// ----------------------------------------------------------------------------
// Fichiers uploadés : Cloudinary si configuré (persistant, survit aux
// redéploiements), sinon disque local (comme avant, non persistant sur Render).
// ----------------------------------------------------------------------------

// Envoie le fichier reçu par multer (req.file) vers Cloudinary, ou renvoie
// simplement son nom local si Cloudinary n'est pas configuré. Retourne
// { reference, estPdf } — "reference" est soit une URL complète (Cloudinary)
// soit un nom de fichier local, selon le mode.
async function traiterFichierUploade(file, sousDossier) {
  const estPdf = file.mimetype === "application/pdf";
  if (!CLOUDINARY_ACTIF) {
    return { reference: file.filename, estPdf };
  }
  const resultat = await new Promise((resolve, reject) => {
    const flux = cloudinary.uploader.upload_stream(
      { folder: `alipafric/${sousDossier}`, resource_type: estPdf ? "raw" : "image" },
      (erreur, res) => (erreur ? reject(erreur) : resolve(res))
    );
    flux.end(file.buffer);
  });
  return { reference: resultat.secure_url, estPdf };
}

// Construit le lien à afficher (href) pour un fichier, quel que soit le mode.
function hrefFichier(reference, cheminWeb) {
  if (!reference) return null;
  if (reference.startsWith("http")) {
    // Les PDF servis par Cloudinary en resource_type "raw" sont téléchargés
    // automatiquement par défaut. On force l'ouverture directe dans le
    // navigateur avec le flag fl_attachment:false.
    if (reference.includes("/raw/upload/") && !reference.includes("fl_attachment")) {
      return reference.replace("/raw/upload/", "/raw/upload/fl_attachment:false/");
    }
    return reference; // Cloudinary : URL déjà complète
  }
  return `/${cheminWeb}/${reference}`; // Mode local — cheminWeb = chemin complet après le "/" (ex: "uploads/identite", "recus", "fiches")
}

// Récupère les octets d'un fichier (pour la génération de PDF), quel que
// soit le mode de stockage.
async function bufferFichier(reference, dossierLocal) {
  if (!reference) return null;
  if (reference.startsWith("http")) {
    const reponse = await axios.get(reference, { responseType: "arraybuffer" });
    return Buffer.from(reponse.data);
  }
  return fs.readFileSync(path.join(dossierLocal, reference));
}

// Génère un PDF avec PDFKit en mémoire (buffer), et l'envoie vers Cloudinary
// si configuré, sinon l'écrit sur le disque local. Retourne { reference }
// (URL Cloudinary ou nom de fichier local, à utiliser avec hrefFichier()).
async function genererEtStockerPDF(nomFichier, construirePDF, sousDossier, dossierLocal) {
  const doc = new PDFDocument({ margin: 40, size: "A4" });
  const morceaux = [];
  const bufferPromesse = new Promise((resolve, reject) => {
    doc.on("data", (m) => morceaux.push(m));
    doc.on("end", () => resolve(Buffer.concat(morceaux)));
    doc.on("error", reject);
  });
  await construirePDF(doc);
  doc.end();
  const buffer = await bufferPromesse;

  if (!CLOUDINARY_ACTIF) {
    fs.writeFileSync(path.join(dossierLocal, nomFichier), buffer);
    return { reference: nomFichier };
  }
  const resultat = await new Promise((resolve, reject) => {
    const flux = cloudinary.uploader.upload_stream(
      { folder: `alipafric/${sousDossier}`, resource_type: "raw", public_id: nomFichier.replace(/\.pdf$/, "") },
      (erreur, res) => (erreur ? reject(erreur) : resolve(res))
    );
    flux.end(buffer);
  });
  return { reference: resultat.secure_url };
}

// ----------------------------------------------------------------------------
// 5) MISE EN PAGE COMMUNE — thème sombre, accents bleu / jaune
// ----------------------------------------------------------------------------
function page(titre, contenuHTML, options = {}) {
  const classeCarte = options.large ? "conteneur conteneur-large" : "conteneur";
  const estAdmin = !!options.admin;
  const manifeste = estAdmin ? "/manifest-admin.json" : "/manifest.json";
  const iconePWA = estAdmin ? "/icons/icon-admin-192.png" : "/icons/icon-192.png";
  const titrePWA = estAdmin ? "AlipAfric Admin" : "AlipAfric";
  const couleurTheme = estAdmin ? "#781414" : "#1B1120";
  return `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${titre} — ${CONFIG.NOM_SITE}</title>
<link rel="icon" type="image/png" href="/favicon.png?v=5">
<link rel="manifest" href="${manifeste}">
<meta name="theme-color" content="${couleurTheme}">
<link rel="apple-touch-icon" href="${iconePWA}">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="${titrePWA}">
<style>
  :root {
    --fond: #1B1120;
    --carte: #111A2E;
    --carte-claire: #17233D;
    --bordure: #24314F;
    --texte: #F4F6FB;
    --texte-att: #8B96AE;
    --bleu: #3B82F6;
    --bleu-fonce: #2563EB;
    --jaune: #F5C518;
    --jaune-fonce: #D4A90F;
    --vert: #22C55E;
    --rouge: #EF4444;
    --orange: #F59E0B;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif;
    background-color: var(--fond);
    background-image: linear-gradient(rgba(28, 45, 90, 0.8), rgba(13, 43, 119, 0.8)), url('/logos/fond.png');
    background-size: contain;
    background-size: cover;
    background-position: center;
    background-attachment: fixed;
    background-repeat: no-repeat;
    color: var(--texte);
  }
  a { color: var(--bleu); }
  .conteneur { max-width: 480px; margin: 0 auto; padding: 20px 16px 60px; }
  .conteneur-large { max-width: 1100px; margin: 0 auto; padding: 20px 16px 60px; }
  .carte { background: var(--carte); border: 1px solid var(--bordure); border-radius: 16px; padding: 24px 20px; margin-bottom: 16px; }
  h1 { font-size: 22px; font-weight: 800; margin: 0 0 6px; }
  h2 { font-size: 16px; font-weight: 700; margin: 0 0 14px; }
  p.souligne { color: var(--texte-att); font-size: 13.5px; margin: 0 0 18px; }
  label { display: block; font-size: 12px; font-weight: 700; color: var(--texte-att); text-transform: uppercase; letter-spacing: 0.04em; margin: 14px 0 6px; }
  input, select, textarea {
    width: 100%; padding: 12px 14px; border-radius: 10px; border: 1px solid var(--bordure);
    background: var(--carte-claire); color: var(--texte); font-size: 15px;
  }
  input:focus, select:focus, textarea:focus { outline: 2px solid var(--bleu); }
  input[readonly] { color: var(--texte-att); }
  button, .bouton {
    display: block; width: 100%; text-align: center; text-decoration: none;
    padding: 13px; border: none; border-radius: 10px; font-size: 15px; font-weight: 700;
    background: var(--bleu); color: #fff; cursor: pointer; margin-top: 18px;
  }
  button.jaune, .bouton.jaune { background: var(--jaune); color: #1A1400; }
  button.fantome, .bouton.fantome { background: transparent; border: 1px solid var(--bordure); color: var(--texte); }
  button.danger, .bouton.danger { background: var(--rouge); }
  button.petit, .bouton.petit { width: auto; display: inline-block; padding: 8px 14px; font-size: 13px; margin-top: 0; }
  .lien-discret { display: block; text-align: center; margin-top: 14px; color: var(--texte-att); font-size: 13px; }
  .ligne { display: flex; justify-content: space-between; align-items: center; padding: 8px 0; border-bottom: 1px solid var(--bordure); font-size: 14px; }
  .ligne:last-child { border-bottom: none; }
  .ligne b { color: var(--texte); }
  .ligne span { color: var(--texte-att); }
  .badge { display: inline-block; font-size: 11px; font-weight: 700; padding: 4px 10px; border-radius: 999px; }
  .badge-encours { background: rgba(245,158,11,0.15); color: var(--orange); }
  .badge-termine { background: rgba(34,197,94,0.15); color: var(--vert); }
  .badge-annule { background: rgba(239,68,68,0.15); color: var(--rouge); }
  .badge-verifie { background: rgba(34,197,94,0.15); color: var(--vert); }
  .badge-attente { background: rgba(245,158,11,0.15); color: var(--orange); }
  .badge-refuse { background: rgba(239,68,68,0.15); color: var(--rouge); }
  .banniere { border-radius: 10px; padding: 14px 16px; font-size: 13.5px; margin-bottom: 18px; line-height: 1.55; }
  .banniere-attente { background: rgba(245,158,11,0.1); border: 1px solid rgba(245,158,11,0.3); color: #FBBF6B; }
  .banniere-succes { background: rgba(34,197,94,0.1); border: 1px solid rgba(34,197,94,0.3); color: #7FE3A6; }
  .banniere-erreur { background: rgba(239,68,68,0.1); border: 1px solid rgba(239,68,68,0.3); color: #F5A3A3; }
  .banniere .bouton { margin-top: 10px; }

  /* Header */
  .entete { background: var(--fond); border-bottom: 1px solid var(--bordure); padding: 14px 20px; display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 10px; }
  .logo { display: flex; align-items: center; gap: 10px; text-decoration: none; }
  .logo-icone { width: 34px; height: 34px; border-radius: 8%; background: #fff; display: flex; align-items: center; justify-content: center; overflow: hidden; }
  .logo-icone img { width: 100%; height: 100%; object-fit: contain; padding: 3px; box-sizing: border-box; }
  .logo-texte b { color: var(--texte); font-weight: 800; font-size: 16px; }
  .logo-texte b span { color: var(--jaune); }
  .logo-texte small { display: block; color: var(--texte-att); font-size: 9px; letter-spacing: 0.08em; }
  .nav-onglets { display: flex; gap: 6px; background: var(--carte); border-radius: 999px; padding: 4px; flex-wrap: wrap; }
  .nav-onglets a { padding: 8px 16px; border-radius: 999px; font-size: 13px; font-weight: 700; color: var(--texte-att); text-decoration: none; }
  .nav-onglets a.actif { background: var(--bleu); color: #fff; }
  .entete-droite { display: flex; align-items: center; gap: 10px; }
  .icone-ronde { width: 34px; height: 34px; border-radius: 50%; background: var(--carte); border: 1px solid var(--bordure); display: flex; align-items: center; justify-content: center; font-size: 13px; color: var(--texte-att); }
  .lien-quitter { color: var(--texte-att); font-size: 13px; font-weight: 700; text-decoration: none; }

  /* Marketing / hero */
  .hero { background: linear-gradient(160deg, #0E1830, #0B1120 70%); border-radius: 18px; padding: 34px 26px; margin-bottom: 20px; border: 1px solid var(--bordure); }
  .hero h1 { font-size: 26px; line-height: 1.3; margin-bottom: 14px; }
  .hero h1 span { color: var(--jaune); }
  .hero p { color: var(--texte-att); font-size: 14.5px; margin-bottom: 20px; }
  .cta-rangee { display: flex; gap: 10px; }
  .cta-rangee .bouton { margin-top: 0; }
  .etape-carte { display: flex; gap: 12px; align-items: flex-start; margin-bottom: 16px; }
  .etape-numero { flex-shrink: 0; width: 30px; height: 30px; border-radius: 50%; background: var(--bleu); color: #fff; display: flex; align-items: center; justify-content: center; font-weight: 800; font-size: 13px; }
  .etape-texte b { display: block; font-size: 14px; margin-bottom: 2px; }
  .etape-texte span { font-size: 12.5px; color: var(--texte-att); }
  .piliers { display: flex; gap: 10px; flex-wrap: wrap; }
  .pilier { flex: 1; min-width: 130px; background: var(--carte); border: 1px solid var(--bordure); border-radius: 12px; padding: 16px; text-align: center; }
  .pilier .icone { font-size: 22px; margin-bottom: 6px; }
  .pilier b { display: block; font-size: 13px; }
  .pied-page { text-align: center; color: var(--texte-att); font-size: 12px; padding: 24px 0 0; }

  /* Stats / cartes de service */
  .taux-boite { background: var(--carte); border: 1px solid var(--bordure); border-radius: 14px; padding: 18px; text-align: center; margin-bottom: 18px; }
  .taux-boite b { display: block; font-size: 26px; color: var(--jaune); margin-top: 4px; }
  .taux-boite span { font-size: 11px; color: var(--texte-att); text-transform: uppercase; letter-spacing: 0.05em; }

  /* Stepper */
  .stepper { display: flex; align-items: flex-start; margin-bottom: 22px; }
  .step { display: flex; flex-direction: column; align-items: center; flex: 1; }
  .step-cercle { width: 30px; height: 30px; border-radius: 50%; background: var(--carte-claire); border: 2px solid var(--bordure); color: var(--texte-att); display: flex; align-items: center; justify-content: center; font-weight: 800; font-size: 12.5px; }
  .step.actif .step-cercle { background: var(--bleu); border-color: var(--bleu); color: #fff; }
  .step.fait .step-cercle { background: var(--vert); border-color: var(--vert); color: #fff; }
  .step-label { font-size: 10.5px; color: var(--texte-att); margin-top: 6px; text-align: center; }
  .step.actif .step-label { color: var(--texte); }
  .step-ligne { flex: 1; height: 2px; background: var(--bordure); margin-top: 14px; }
  .step-ligne.fait { background: var(--vert); }

  /* Formulaire fichier */
  .zone-fichier { border: 2px dashed var(--bordure); border-radius: 12px; padding: 20px; text-align: center; background: var(--carte-claire); }
  .zone-fichier input[type="file"] { border: none; padding: 0; background: transparent; font-size: 13px; }
  .zone-fichier .indice { font-size: 11.5px; color: var(--texte-att); margin-top: 6px; }
  .apercu-image { width: 100%; max-width: 200px; border-radius: 10px; border: 1px solid var(--bordure); margin: 10px auto 0; display: block; }

  /* Boîte paiement */
  .boite-paiement { background: var(--carte-claire); border-radius: 10px; padding: 14px 16px; margin-top: 12px; display: flex; flex-direction: column; }
  .boite-paiement small { display: block; color: var(--jaune-fonce); font-size: 11px; font-weight: 700; text-transform: uppercase; margin-bottom: 4px; }
  .boite-paiement b { display: block; width: 100%; font-size: 26px; font-weight: 800; letter-spacing: 0.02em; word-break: break-all; margin-bottom: 10px; }
  .boite-paiement .nom-titulaire { display: block; font-size: 12.5px; color: var(--texte-att); margin-top: -6px; margin-bottom: 10px; }
  .btn-copier { align-self: flex-end; background: var(--bleu); border: none; color: #fff; border-radius: 8px; padding: 6px 14px; cursor: pointer; font-size: 12px; font-weight: 700; }
  h1#formulaire { scroll-margin-top: 20px; }
  .moyen-option { display: flex; align-items: center; gap: 10px; background: var(--carte-claire); border: 1px solid var(--bordure); border-radius: 10px; padding: 2px 14px; margin-bottom: 8px; text-transform: none; cursor: pointer; transition: background 0.15s, border-color 0.15s; }
  .moyen-option input[type="radio"] { width: auto; accent-color: var(--bleu); outline: none; box-shadow: none; }
  .moyen-option input[type="radio"]:focus, .moyen-option input[type="radio"]:focus-visible { outline: none; box-shadow: none; }
  .moyen-option span { font-weight: 700; font-size: 14px; }
  .moyen-option.selectionne { background: var(--jaune); border-color: var(--jaune); }
  .moyen-option.selectionne span { color: #1A1400; }
  .avertissement { background: rgba(245,158,11,0.1); border: 1px solid rgba(245,158,11,0.3); color: #FBBF6B; border-radius: 8px; padding: 10px 12px; font-size: 12.5px; margin-top: 14px; }

  /* Tracker horizontal (récap transaction) */
  .tracker { display: flex; margin: 18px 0; }
  .tracker .pt { flex: 1; text-align: center; }
  .tracker .rond { width: 34px; height: 34px; border-radius: 50%; background: var(--carte-claire); border: 2px solid var(--bordure); display: flex; align-items: center; justify-content: center; margin: 0 auto 6px; color: var(--texte-att); }
  .tracker .pt.fait .rond { background: var(--bleu); border-color: var(--bleu); color: #fff; }
  .tracker .pt span { font-size: 10.5px; color: var(--texte-att); }

  /* Historique */
  .item-historique { background: var(--carte); border: 1px solid var(--bordure); border-radius: 12px; padding: 16px; margin-bottom: 10px; text-decoration: none; display: block; color: var(--texte); }
  .item-historique .titre-item { font-weight: 700; font-size: 14px; margin-bottom: 8px; display: flex; justify-content: space-between; align-items: center; }
  .filtres-date { display: flex; gap: 8px; margin-bottom: 16px; flex-wrap: wrap; }
  .filtres-date a { padding: 6px 12px; border-radius: 999px; border: 1px solid var(--bordure); font-size: 12.5px; color: var(--texte-att); text-decoration: none; }
  .filtres-date a.actif { background: var(--bleu); color: #fff; border-color: var(--bleu); }

  /* Support */
  .support-tuile { background: var(--carte); border: 1px solid var(--bordure); border-radius: 12px; padding: 18px; margin-bottom: 14px; }
  details.faq { background: var(--carte); border: 1px solid var(--bordure); border-radius: 10px; padding: 12px 16px; margin-bottom: 8px; }
  details.faq summary { cursor: pointer; font-weight: 700; font-size: 13.5px; list-style: none; }
  details.faq summary::-webkit-details-marker { display: none; }
  details.faq p { color: var(--texte-att); font-size: 13px; margin: 10px 0 0; }

  .aucune-donnee { text-align: center; color: var(--texte-att); padding: 30px 0; font-size: 14px; }

  /* Admin */
  table.admin { width: 100%; border-collapse: collapse; font-size: 13px; margin-top: 12px; }
  table.admin th { text-align: left; font-size: 11px; text-transform: uppercase; color: var(--texte-att); border-bottom: 1px solid var(--bordure); padding: 8px 10px; }
  table.admin td { padding: 10px; border-bottom: 1px solid var(--bordure); vertical-align: middle; }
  table.admin img.miniature { width: 46px; height: 46px; object-fit: cover; border-radius: 8px; border: 1px solid var(--bordure); }
  .mini-bouton { display: inline-block; font-size: 12px; font-weight: 700; padding: 6px 10px; border-radius: 6px; border: none; cursor: pointer; margin: 2px 4px 2px 0; }
  .mini-bouton.ok { background: var(--vert); color: #08240F; }
  .mini-bouton.info { background: var(--bleu); color: #fff; }
  .mini-bouton.refus { background: var(--rouge); color: #fff; }
  .nav-admin { display: flex; gap: 10px; margin-bottom: 20px; flex-wrap: wrap; }
  .nav-admin a { font-size: 13px; font-weight: 700; color: var(--bleu); text-decoration: none; padding: 6px 12px; border: 1px solid var(--bordure); border-radius: 999px; }
</style>
</head>
<body>
  <div class="${classeCarte}">
    ${contenuHTML}
  </div>
  <button id="btnInstallerApp" class="bouton jaune" style="display:none; position:fixed; bottom:18px; right:18px; left:auto; width:auto; margin:0; padding:12px 18px; z-index:999; box-shadow:0 6px 18px rgba(0,0,0,0.45); border-radius:999px;">📲 Installer l'application</button>
  <script>
    function copierTexte(id) {
      const el = document.getElementById(id);
      if (!el) return;
      navigator.clipboard && navigator.clipboard.writeText(el.textContent.trim());
      const btn = event.target;
      const original = btn.textContent;
      btn.textContent = "Copié !";
      setTimeout(() => { btn.textContent = original; }, 1500);
    }
    if ("serviceWorker" in navigator) {
      window.addEventListener("load", () => {
        navigator.serviceWorker.register("/sw.js").catch(() => {});
      });
    }

    // Bouton d'installation visible directement sur le site (pas seulement
    // dans la barre d'adresse du navigateur).
    let promptInstallDiffere = null;
    const btnInstaller = document.getElementById('btnInstallerApp');
    const dejaInstallee = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;

    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      promptInstallDiffere = e;
      if (btnInstaller && !dejaInstallee) btnInstaller.style.display = 'block';
    });

    if (btnInstaller) {
      btnInstaller.addEventListener('click', async () => {
        if (!promptInstallDiffere) return;
        promptInstallDiffere.prompt();
        await promptInstallDiffere.userChoice;
        promptInstallDiffere = null;
        btnInstaller.style.display = 'none';
      });
    }

    window.addEventListener('appinstalled', () => {
      if (btnInstaller) btnInstaller.style.display = 'none';
    });
  </script>
</body>
</html>`;
}

function entete(actif, utilisateur) {
  const onglets = [
    { cle: "accueil", lien: "/compte", texte: "Accueil" },
    { cle: "historique", lien: "/compte/historique", texte: "Historique" },
    { cle: "support", lien: "/compte/support", texte: "Support" },
    { cle: "profil", lien: "/compte/profil", texte: "Profil" },
  ];
  const liens = onglets.map((o) => `<a class="${o.cle === actif ? "actif" : ""}" href="${o.lien}">${o.texte}</a>`).join("");
  const nonLues = utilisateur ? notifications.filter((n) => n.utilisateurId === utilisateur.id && !n.lu).length : 0;
  return `
    <header class="entete">
      <a class="logo" href="/compte">
        <div class="logo-icone"><img src="/logos/logo.png" alt="ALIPAFRIC"></div>
        <div class="logo-texte"><b>ALIPA<span>FRIC</span></b><small>${CONFIG.TAGLINE}</small></div>
      </a>
      <nav class="nav-onglets">${liens}</nav>
      <div class="entete-droite">
        <a class="icone-ronde" href="/compte/notifications" style="position:relative; text-decoration:none;">
          🔔${nonLues > 0 ? `<span style="position:absolute; top:-4px; right:-4px; background:var(--rouge); color:#fff; font-size:9px; font-weight:800; border-radius:999px; padding:1px 5px;">${nonLues}</span>` : ""}
        </a>
        <div class="icone-ronde">FR</div>
        <a class="lien-quitter" href="/deconnexion">↪ Quitter</a>
      </div>
    </header>`;
}

function stepper(etapeActuelle, labels) {
  return `<div class="stepper">${labels
    .map((label, i) => {
      const n = i + 1;
      const etat = n < etapeActuelle ? "fait" : n === etapeActuelle ? "actif" : "";
      const cercle = n < etapeActuelle ? "✓" : n;
      const ligne = n < labels.length ? `<div class="step-ligne ${n < etapeActuelle ? "fait" : ""}"></div>` : "";
      return `<div class="step ${etat}"><div class="step-cercle">${cercle}</div><div class="step-label">${label}</div></div>${ligne}`;
    })
    .join("")}</div>`;
}

function statutTransactionAffiche(statut) {
  if (statut === "effectue") return { texte: "Terminé", classe: "badge-termine" };
  if (statut === "annule") return { texte: "Annulé", classe: "badge-annule" };
  return { texte: "En cours", classe: "badge-encours" };
}

// ============================================================================
// 6) PAGE PUBLIQUE D'ACCUEIL
// ============================================================================
function enTeteEtHero() {
  return `
    <header class="entete" style="margin: -20px -16px 24px; padding: 16px 24px;">
      <a class="logo" href="/">
        <div class="logo-icone"><img src="/logos/logo.png" alt="ALIPAFRIC"></div>
        <div class="logo-texte"><b>ALIPA<span>FRIC</span></b><small>${CONFIG.TAGLINE}</small></div>
      </a>
      <div class="cta-rangee">
        <a class="bouton fantome petit" href="/connexion#formulaire">Connexion</a>
        <a class="bouton jaune petit" href="/inscription#formulaire">S'inscrire</a>
      </div>
    </header>

    <section class="hero">
      <h1>Rechargez votre <span>Alipay</span> depuis l'Afrique, en toute confiance</h1>
      <p>Envoyez vos F CFA, nous rechargeons votre compte Alipay en RMB. Rapide, suivi de bout en bout, et vérifié.</p>
      <div class="cta-rangee">
        <a class="bouton jaune" href="/inscription#formulaire">Commencer maintenant</a>
        <a class="bouton fantome" href="/connexion#formulaire">Se connecter</a>
      </div>
    </section>

    <div class="taux-boite">
      <span>Le Yuan à partir de</span>
      <b>93 F CFA</b>
      <span style="display:block; margin-top:6px; text-transform:none; letter-spacing:0; font-size:14.5px; font-weight:700; color:var(--jaune);">Plus vous achetez, plus le taux baisse !</span>
    </div>
  `;
}

app.get("/", (req, res) => {
  if (req.utilisateur) return res.redirect("/compte");

  const contenu = `
    ${enTeteEtHero()}
    <div class="carte">
      <h2>Comment ça marche</h2>
      <div class="etape-carte"><div class="etape-numero">1</div><div class="etape-texte"><b>Créez votre compte</b><span>Puis complétez votre profil et votre pièce d'identité.</span></div></div>
      <div class="etape-carte"><div class="etape-numero">2</div><div class="etape-texte"><b>Faites vérifier votre identité</b><span>Nécessaire avant toute première recharge.</span></div></div>
      <div class="etape-carte"><div class="etape-numero">3</div><div class="etape-texte"><b>Rechargez votre Alipay</b><span>Indiquez le montant, payez, recevez vos RMB.</span></div></div>
    </div>

    <div class="piliers">
      <div class="pilier"><div class="icone">🔒</div><b>Sécurisée</b></div>
      <div class="pilier"><div class="icone">⚡</div><b>Rapide</b></div>
      <div class="pilier"><div class="icone">✅</div><b>Fiable</b></div>
      <div class="pilier"><div class="icone">🎧</div><b>Support 24/7</b></div>
    </div>

    <div class="pied-page">© ${new Date().getFullYear()} ${CONFIG.NOM_SITE}. Tous droits réservés.</div>
  `;
  res.send(page(CONFIG.NOM_SITE, contenu));
});

// ============================================================================
// 7) INSCRIPTION / CONNEXION / EMAIL
// ============================================================================
function caseAfficherMdp(idsChamps) {
  const cibles = idsChamps.map((id) => `document.getElementById('${id}').type=this.checked?'text':'password';`).join("");
  return `
    <label style="display:flex; align-items:center; gap:8px; text-transform:none; font-weight:400; color:var(--texte-att); margin-top:10px; font-size:13px;">
      <input type="checkbox" style="width:auto;" onclick="${cibles}">
      Afficher le mot de passe
    </label>`;
}

function pageInscription({ email = "", erreurMdp = null, erreurGlobal = null, erreurCGU = null, cguCochee = false } = {}) {
  const contenu = `
    ${enTeteEtHero()}
    <h1 id="formulaire">Créer un compte</h1>
    <p class="souligne">Un code de confirmation sera affiché juste après l'inscription.</p>
    ${erreurGlobal ? `<div class="banniere banniere-erreur">${erreurGlobal}</div>` : ""}
    <div class="carte">
      <form method="POST" action="/inscription">
        <label for="email">Adresse e-mail</label>
        <input type="email" id="email" name="email" value="${email}" required>

        <label for="motDePasse">Mot de passe</label>
        <input type="password" id="motDePasse" name="motDePasse" minlength="8" required>
        ${erreurMdp ? `<p style="color:var(--rouge); font-size:12.5px; margin:6px 0 0;">${erreurMdp}</p>` : ""}

        <label for="confirmation">Confirmer le mot de passe</label>
        <input type="password" id="confirmation" name="confirmation" minlength="8" required>
        ${caseAfficherMdp(["motDePasse", "confirmation"])}

        <label style="display:flex; align-items:flex-start; gap:8px; text-transform:none; font-weight:400; color:var(--texte-att); margin-top:14px; font-size:13px;">
          <input type="checkbox" name="cgu" value="oui" style="width:auto; margin-top:2px;" ${cguCochee ? "checked" : ""} required>
          <span>J'ai lu et j'accepte les <a href="/conditions-utilisation" target="_blank" class="souligne">Conditions Générales d'Utilisation et de Vente (CGU/CGV)</a>.</span>
        </label>
        ${erreurCGU ? `<p style="color:var(--rouge); font-size:12.5px; margin:6px 0 0;">${erreurCGU}</p>` : ""}

        <button type="submit">Créer mon compte</button>
      </form>
    </div>
    <a class="lien-discret" href="/connexion#formulaire">Déjà un compte ? Se connecter</a>
  `;
  return page("Créer un compte", contenu);
}

app.get("/conditions-utilisation", (req, res) => {
  const contenu = `
    <h1>Conditions Générales d'Utilisation (CGU) et de Vente (CGV)</h1>
    <div class="carte" style="line-height:1.7;">
      <p><b>Dernière mise à jour :</b> 1 août 2026</p>

      <h3>ARTICLE 1 : MENTIONS LÉGALES ET OBJET</h3>
      <p><b>1.1 Éditeur du Service</b><br>
      Le présent service de recharge et d'assistance à la commande est édité et géré par ${CONFIG.NOM_SITE}, domiciliée à Lomé, Togo, représentée par son promoteur (ci-après désigné « le Prestataire »).</p>
      <p>Contact WhatsApp / Téléphone : +228 92 90 82 35 / +228 99 24 83 36<br>
      Adresse e-mail : sherlockgroup1@gmail.com</p>

      <p><b>1.2 Nature du Service</b><br>
      Le Prestataire propose un service d'intermédiation commercial, d'assistance technique et de mandat d'achat permettant aux utilisateurs de recharger leur compte marchand tiers (notamment Alipay et WeChat Pay) ou d'effectuer des règlements de fournisseurs en Chine.</p>
      <p><i>Avertissement :</i> Le Prestataire agit exclusivement en qualité de mandataire et prestataire de services indépendants. Le Prestataire n'est ni un établissement bancaire, ni un organisme de crédit, ni un bureau de change manuel au sens de la réglementation bancaire en vigueur dans la zone UEMOA.</p>

      <h3>ARTICLE 2 : ACCEPTATION DES CONDITIONS</h3>
      <p>L'accès, la navigation sur la plateforme ou l'utilisation des services (via le site web, l'application ou les canaux WhatsApp/réseaux sociaux officiels) implique l'acceptation sans réserve des présentes CGU/CGV par l'utilisateur (ci-après désigné « le Client »).</p>

      <h3>ARTICLE 3 : ÉLIGIBILITÉ ET VÉRIFICATION D'IDENTITÉ (POLITIQUE KYC)</h3>
      <p>Pour des raisons de sécurité, de lutte contre la fraude et le blanchiment de capitaux, l'accès aux services est soumis à des conditions strictes d'identification :</p>
      <p><b>Capacité juridique :</b> Le Client doit être âgé d'au moins 18 ans et disposer de la pleine capacité juridique.</p>
      <p><b>Fourniture de pièce d'identité (KYC) :</b> Lors de la première commande (ou à tout moment sur demande du Prestataire), le Client s'engage à fournir une copie lisible d'une pièce d'identité officielle en cours de validité (Carte Nationale d'Identité, Passeport ou Carte d'Électeur).</p>
      <p><b>Correspondance stricte des identités :</b></p>
      <ul>
        <li>Le nom figurant sur la pièce d'identité doit correspondre exactement au nom du titulaire du compte Mobile Money (T-Money, Moov Money, Wave, Orange Money, etc.) émetteur du paiement.</li>
        <li>Il doit également correspondre à l'identité du compte Alipay / WeChat Pay destinataire.</li>
      </ul>
      <p><b>Droit de refus :</b> Le Prestataire se réserve le droit de refuser, suspendre ou annuler toute transaction dont le numéro payeur ne correspond pas à l'identité déclarée du Client, ou en cas de doute sur l'origine des fonds.</p>

      <h3>ARTICLE 4 : TARIF, TAUX ET MODALITÉS DE PAIEMENT</h3>
      <p><b>Transparence des Prix :</b> Les tarifs applicables, exprimés en Francs CFA (XOF), correspondent au taux de change en vigueur en Yuans (CNY), sans frais de service additionnels.</p>
      <p><b>Fluctuation des Taux :</b> Les taux d'intermédiation appliqués peuvent être révisés à tout moment en fonction des variations du marché financier et des frais d'opération. Le taux applicable est celui affiché ou confirmé au Client au moment de la validation de sa commande.</p>
      <p><b>Modalités de Règlement :</b> Toute prestation est payable 100 % d'avance par Mobile Money (T-Money, Moov Money, Wave, Orange Money, etc.) ou par virement bancaire sur les comptes officiels indiqués par le Prestataire.</p>

      <h3>ARTICLE 5 : EXÉCUTION DU SERVICE ET DÉLAIS</h3>
      <p><b>Exécution :</b> La prestation de recharge est exécutée dès confirmation de la réception effective de la totalité du montant en FCFA sur le compte du Prestataire.</p>
      <p><b>Délai d'exécution :</b> Le délai moyen de traitement varie de 5 minutes à 2 heures à compter de la validation du paiement. En cas de contraintes techniques ou d'indisponibilité du réseau tiers, ce délai peut s'étendre jusqu'à 24 heures.</p>
      <p><b>Responsabilité des Informations Saisies :</b> Le Client est seul responsable de la précision des informations fournies (adresse e-mail Alipay, numéro de téléphone relié à Alipay, QR Code, identifiant WeChat).</p>
      <p>En cas d'erreur de saisie de la part du Client conduisant à un transfert vers un mauvais compte tiers, la responsabilité du Prestataire est totalement dégagée et aucun remboursement ne pourra être réclamé.</p>

      <h3>ARTICLE 6 : RÉTRACTATION, ANNULATION ET REMBOURSEMENT</h3>
      <p><b>Caractère Définitif :</b> En raison de la nature instantanée et irréversible des transferts électroniques sur les plateformes Alipay et WeChat Pay, aucune annulation ni remboursement n'est possible une fois le transfert exécuté vers le compte indiqué par le Client.</p>
      <p><b>Impossibilité d'Exécution :</b> Si le Prestataire se trouve dans l'impossibilité d'exécuter la recharge de son propre fait (ex. indisponibilité de stock de devises), le montant payé en FCFA sera intégralement restitué au Client sur le compte Mobile Money émetteur, sans frais supplémentaires.</p>

      <h3>ARTICLE 7 : PROTECTION DES DONNÉES PERSONNELLES</h3>
      <p><b>Confidentialité :</b> Le Prestataire s'engage à conserver la confidentialité des données personnelles collectées (pièces d'identité, numéros de téléphone, historique de transactions).</p>
      <p><b>Non-cession :</b> Les données des Clients ne seront en aucun cas vendues, louées ou cédées à des tiers à des fins commerciales.</p>
      <p><b>Conservation légale :</b> Les preuves de transactions et copies de pièces d'identité sont archivées de manière sécurisée uniquement à des fins de suivi interne, de preuve comptable et d'obligations légales en cas de réquisition par les autorités compétentes.</p>

      <h3>ARTICLE 8 : LIMITATION DE RESPONSABILITÉ</h3>
      <p>Le Prestataire ne saurait être tenu pour responsable :</p>
      <ul>
        <li>Des dysfonctionnements, pannes, blocages ou suspensions de compte survenus sur les plateformes tiers (Alipay, WeChat Pay, Pinduoduo, 1688, etc.) ou sur les réseaux des opérateurs de téléphonie mobile (Togocom, Moov Africa, etc.).</li>
        <li>Des retards d'exécution dus à des cas de force majeure (coupures de réseau Internet, pannes électriques nationales, décisions gouvernementales ou réglementaires).</li>
      </ul>

      <h3>ARTICLE 9 : DROIT APPLICABLE ET RÈGLEMENT DES LITIGES</h3>
      <p>Les présentes conditions sont soumises au droit commercial applicable au Togo et aux dispositions du droit des affaires de l'OHADA.</p>
      <p>En cas de contestation ou de litige, le Client s'engage à contacter en priorité le service client du Prestataire afin de rechercher une solution à l'amiable. À défaut de résolution amiable dans un délai de soixante (60) jours, le litige sera porté devant les tribunaux compétents de Lomé (Togo).</p>
    </div>
    <a class="lien-discret" href="/inscription#formulaire">← Retour à l'inscription</a>
  `;
  res.send(page("Conditions générales d'utilisation et de vente", contenu));
});

app.get("/inscription", (req, res) => res.send(pageInscription()));

app.post("/inscription", (req, res) => {
  const { email, motDePasse, confirmation, cgu } = req.body;
  if (!email || !motDePasse) return res.status(400).send(pageInscription({ email, erreurGlobal: "Merci de remplir tous les champs." }));
  if (motDePasse !== confirmation) return res.status(400).send(pageInscription({ email, erreurMdp: "Les mots de passe ne correspondent pas." }));
  if (!motDePasseRobuste(motDePasse)) {
    return res.status(400).send(pageInscription({ email, erreurMdp: "Au moins 8 caractères, une majuscule, une minuscule et un chiffre." }));
  }
  if (cgu !== "oui") {
    return res.status(400).send(pageInscription({ email, erreurCGU: "Vous devez accepter les conditions d'utilisation pour créer un compte." }));
  }
  const compteExistant = utilisateurs.find((u) => u.identifiant.toLowerCase() === email.toLowerCase());
  if (compteExistant && !compteExistant.compteSupprime) {
    return res.status(400).send(pageInscription({ email, cguCochee: true, erreurGlobal: "Ce compte existe déjà. Essayez de vous connecter plutôt." }));
  }
  if (compteExistant && compteExistant.compteSupprime) {
    return res.status(400).send(pageInscription({ email, cguCochee: true, erreurGlobal: `Un ancien compte a existé avec cette adresse e-mail. Contactez le support pour le réactiver, ou utilisez une autre adresse e-mail.<a class="bouton jaune petit" style="margin-top:10px;" href="mailto:${CONFIG.CONTACT_EMAIL}?subject=${encodeURIComponent("Réactivation de mon compte " + CONFIG.NOM_SITE)}&body=${encodeURIComponent("Bonjour,\n\nJe souhaite réactiver mon compte " + CONFIG.NOM_SITE + " associé à l'adresse : " + email + "\n\nMerci.")}">Contacter le support par e-mail</a>` }));
  }

  const { sel, hash } = hacherMotDePasse(motDePasse);
  const utilisateur = {
    id: crypto.randomUUID(),
    identifiant: email,
    motDePasseSel: sel,
    motDePasseHash: hash,
    pseudo: genererPseudo(),
    emailVerifie: false,
    codeEmail: genererCode(),
    nom: null,
    prenom: null,
    telephone: null,
    pieceIdentite: null,
    statutVerification: "profil_incomplet",
    raisonRefus: null,
    dateInscription: new Date().toISOString(),
    cguAccepteesLe: new Date().toISOString(),
  };
  utilisateurs.push(utilisateur);
  sauvegarderJSON(FICHIER_UTILISATEURS, utilisateurs);
  connecterUtilisateur(res, utilisateur.id);
  envoyerEmailConfirmationInscription(utilisateur.identifiant, utilisateur.codeEmail)
    .catch((err) => console.error("Erreur e-mail confirmation inscription :", err.message));
  res.redirect("/confirmer-email");
});

app.get("/confirmer-email", exigerConnexion, (req, res) => {
  const u = req.utilisateur;
  if (u.emailVerifie) return res.redirect("/compte");
  const contenu = `
    <h1>Confirmez votre e-mail</h1>
    <p class="souligne">Un code vient de vous être envoyé par e-mail à ${u.identifiant}.</p>
    <div class="carte">
      <form method="POST" action="/confirmer-email">
        <label for="code">Code à 6 chiffres</label>
        <input type="text" id="code" name="code" maxlength="6" required>
        <button type="submit">Confirmer</button>
      </form>
    </div>
    <a class="lien-discret" href="/confirmer-email/renvoyer">Renvoyer un code</a>
  `;
  res.send(page("Confirmer l'e-mail", contenu));
});
app.post("/confirmer-email", exigerConnexion, (req, res) => {
  const u = req.utilisateur;
  if (req.body.code !== u.codeEmail) {
    return res.status(400).send(page("Confirmer l'e-mail", `<h1>Confirmez votre e-mail</h1><div class="banniere banniere-erreur">Code incorrect.</div><div class="carte"><form method="POST" action="/confirmer-email"><label for="code">Code à 6 chiffres</label><input type="text" id="code" name="code" maxlength="6" required><button type="submit">Confirmer</button></form></div>`));
  }
  u.emailVerifie = true;
  u.codeEmail = null;
  sauvegarderJSON(FICHIER_UTILISATEURS, utilisateurs);
  // ➕ AJOUT : L'e-mail de bienvenue part MAINTENANT que l'e-mail est confirmé
  envoyerEmailBienvenue(u.identifiant, u.pseudo || "Client")
    .catch((err) => console.error("Erreur e-mail bienvenue :", err.message))
  res.redirect("/compte");
});
app.get("/confirmer-email/renvoyer", exigerConnexion, (req, res) => {
  req.utilisateur.codeEmail = genererCode();
  sauvegarderJSON(FICHIER_UTILISATEURS, utilisateurs);
  envoyerEmailConfirmationInscription(req.utilisateur.identifiant, req.utilisateur.codeEmail)
    .catch((err) => console.error("Erreur e-mail renvoi confirmation :", err.message));
  res.redirect("/confirmer-email");
});

function pageConnexion({ identifiant = "", erreurGlobal = null } = {}) {
  const contenu = `
    ${enTeteEtHero()}
    <h1 id="formulaire">Se connecter</h1>
    ${erreurGlobal ? `<div class="banniere banniere-erreur">${erreurGlobal}</div>` : ""}
    <div class="carte">
      <form method="POST" action="/connexion">
        <label for="identifiant">E-mail</label>
        <input type="text" id="identifiant" name="identifiant" value="${identifiant}" required>
        <label for="motDePasse">Mot de passe</label>
        <input type="password" id="motDePasse" name="motDePasse" required>
        ${caseAfficherMdp(["motDePasse"])}
        <button type="submit">Se connecter</button>
      </form>
    </div>
    <a class="lien-discret" href="/mot-de-passe-oublie">Mot de passe oublié ?</a><br>
    <a class="lien-discret" href="/inscription#formulaire">Pas encore de compte ? Créer un compte</a>
  `;
  return page("Se connecter", contenu);
}
app.get("/connexion", (req, res) => res.send(pageConnexion()));
app.post("/connexion", (req, res) => {
  const { identifiant, motDePasse } = req.body;
  const u = utilisateurs.find((x) => x.identifiant.toLowerCase() === (identifiant || "").toLowerCase());
  if (!u || !motDePasseCorrect(motDePasse || "", u.motDePasseSel, u.motDePasseHash)) {
    return res.status(401).send(pageConnexion({ identifiant: "", erreurGlobal: "Identifiant ou mot de passe incorrect." }));
  }
  if (u.compteSupprime) {
    return res.status(401).send(pageConnexion({ identifiant: "", erreurGlobal: `Ce compte a été supprimé. Si vous pensez qu'il s'agit d'une erreur, contactez le support.<a class="bouton jaune petit" style="margin-top:10px;" href="mailto:${CONFIG.CONTACT_EMAIL}?subject=${encodeURIComponent("Compte supprimé par erreur — " + CONFIG.NOM_SITE)}&body=${encodeURIComponent("Bonjour,\n\nMon compte associé à l'adresse " + (identifiant || "") + " a été supprimé alors que je pense qu'il s'agit d'une erreur. Merci de vérifier.\n\nMerci.")}">Contacter le support par e-mail</a>` }));
  }
  connecterUtilisateur(res, u.id);
  res.redirect(u.emailVerifie ? "/compte" : "/confirmer-email");
});
app.get("/deconnexion", (req, res) => {
  deconnecterUtilisateur(req, res);
  res.redirect("/");
});

// ----------------------------------------------------------------------------
// Mot de passe oublié
// ----------------------------------------------------------------------------
function pageMotDePasseOublie({ erreurGlobal = null } = {}) {
  const contenu = `
    ${enTeteEtHero()}
    <h1 id="formulaire">Mot de passe oublié</h1>
    <p class="souligne">Indiquez l'adresse e-mail de votre compte pour recevoir un code de réinitialisation.</p>
    ${erreurGlobal ? `<div class="banniere banniere-erreur">${erreurGlobal}</div>` : ""}
    <div class="carte">
      <form method="POST" action="/mot-de-passe-oublie">
        <label for="email">Adresse e-mail</label>
        <input type="email" id="email" name="email" required>
        <button type="submit">Recevoir le code</button>
      </form>
    </div>
    <a class="lien-discret" href="/connexion#formulaire">← Retour à la connexion</a>
  `;
  return page("Mot de passe oublié", contenu);
}
app.get("/mot-de-passe-oublie", (req, res) => res.send(pageMotDePasseOublie()));
app.post("/mot-de-passe-oublie", async (req, res) => {
  const email = (req.body.email || "").trim();
  const u = utilisateurs.find((x) => x.identifiant.toLowerCase() === email.toLowerCase());
  // Message identique que le compte existe ou non, pour ne pas révéler quels e-mails sont inscrits.
  if (!u) {
    return res.send(pageMotDePasseOublie({ erreurGlobal: "Si un compte existe avec cet e-mail, un code de réinitialisation a été envoyé." }));
  }
  u.codeReinitialisation = genererCode();
  u.codeReinitialisationExpire = Date.now() + 15 * 60 * 1000; // valable 15 minutes
  sauvegarderJSON(FICHIER_UTILISATEURS, utilisateurs);
  // 2. On APPELLE la fonction pour envoyer le mail
  await envoyerEmailReinitialisation(u.identifiant, u.codeReinitialisation);

  // Le compte existe et l'e-mail est parti : direction la page où saisir le code + le nouveau mot de passe.
  return res.redirect(`/reinitialiser-mot-de-passe?email=${encodeURIComponent(u.identifiant)}`);
});
  // Fonction pour envoyer l'e-mail de réinitialisation avec le code en grand
async function envoyerEmailReinitialisation(destinataire, code) {
  const contenuMail = `
    <p>Bonjour,</p>
    <p>Vous avez demandé la réinitialisation du mot de passe pour le compte <b>${destinataire}</b>.</p>
    <p>Voici votre code de vérification à saisir sur le site :</p>
    
    <!-- Code de vérification mis en valeur -->
    <div style="text-align: center; margin: 30px 0;">
      <span style="background-color: #f0f4f8; color: #2b5b9a; font-size: 32px; font-weight: bold; letter-spacing: 8px; padding: 14px 28px; border-radius: 6px; border: 2px dashed #2b5b9a; display: inline-block;">
        ${code}
      </span>
    </div>

    <p style="font-size: 13px; color: #666666;">Ce code est confidentiel. Ne le partagez avec personne.</p>
  `;

  return await envoyerEmail(
    destinataire,
    "Réinitialisation de votre mot de passe - ALIPAFRIC",
    contenuMail,
    "Code de réinitialisation du mot de passe" // Titre principal dans le mail
  );
}

function pageReinitialiserMotDePasse({ email = "", code = "", erreurGlobal = null, erreurMdp = null, codeDemo = null } = {}) {
  const contenu = `
    <h1>Réinitialiser le mot de passe</h1>
    <p class="souligne">Un code de vérification vient de vous être envoyé par e-mail${email ? ` à ${email}` : ""}.</p>
    ${codeDemo ? `<div class="banniere banniere-attente">Code de démonstration (pas de service e-mail réel connecté) : <b style="font-size:18px;">${codeDemo}</b></div>` : ""}
    ${erreurGlobal ? `<div class="banniere banniere-erreur">${erreurGlobal}</div>` : ""}
    <div class="carte">
      <form method="POST" action="/reinitialiser-mot-de-passe">
        <label for="email">Adresse e-mail</label>
        <input type="email" id="email" name="email" value="${email}" required>

        <label for="code">Code à 6 chiffres</label>
        <input type="text" id="code" name="code" maxlength="6" value="${code}" required>

        <label for="motDePasse">Nouveau mot de passe</label>
        <input type="password" id="motDePasse" name="motDePasse" minlength="8" required>
        ${erreurMdp ? `<p style="color:var(--rouge); font-size:12.5px; margin:6px 0 0;">${erreurMdp}</p>` : ""}

        <label for="confirmation">Confirmer le nouveau mot de passe</label>
        <input type="password" id="confirmation" name="confirmation" minlength="8" required>
        ${caseAfficherMdp(["motDePasse", "confirmation"])}

        <button type="submit">Réinitialiser mon mot de passe</button>
      </form>
    </div>
    <a class="lien-discret" href="/mot-de-passe-oublie">Renvoyer un code</a><br>
    <a class="lien-discret" href="/connexion#formulaire">← Retour à la connexion</a>
  `;
  return page("Réinitialiser le mot de passe", contenu);
}
app.get("/reinitialiser-mot-de-passe", (req, res) => {
  const email = req.query.email || "";
  const u = utilisateurs.find((x) => x.identifiant.toLowerCase() === email.toLowerCase());
  res.send(pageReinitialiserMotDePasse({ email, }));
});
app.post("/reinitialiser-mot-de-passe", (req, res) => {
  const { email, code, motDePasse, confirmation } = req.body;
  const u = utilisateurs.find((x) => x.identifiant.toLowerCase() === (email || "").toLowerCase());

  if (!u || !u.codeReinitialisation || u.codeReinitialisation !== code) {
    return res.status(400).send(pageReinitialiserMotDePasse({ email, erreurGlobal: "Code incorrect." }));
  }
  if (!u.codeReinitialisationExpire || Date.now() > u.codeReinitialisationExpire) {
    return res.status(400).send(pageReinitialiserMotDePasse({ email, erreurGlobal: "Ce code a expiré. Merci d'en demander un nouveau." }));
  }
  if (motDePasse !== confirmation) {
    return res.status(400).send(pageReinitialiserMotDePasse({ email, code, erreurMdp: "Les mots de passe ne correspondent pas." }));
  }
  if (!motDePasseRobuste(motDePasse)) {
    return res.status(400).send(pageReinitialiserMotDePasse({ email, code, erreurMdp: "Au moins 8 caractères, une majuscule, une minuscule et un chiffre." }));
  }

  const { sel, hash } = hacherMotDePasse(motDePasse);
  u.motDePasseSel = sel;
  u.motDePasseHash = hash;
  u.codeReinitialisation = null;
  u.codeReinitialisationExpire = null;
  sauvegarderJSON(FICHIER_UTILISATEURS, utilisateurs);

  res.send(page("Mot de passe réinitialisé", `<h1>C'est fait ✔</h1><p class="souligne">Votre mot de passe a été réinitialisé avec succès.</p><a class="bouton jaune" href="/connexion#formulaire">Se connecter</a>`));
});

// ============================================================================
// 8) ESPACE PERSONNEL — ACCUEIL
// ============================================================================
app.get("/compte", exigerConnexion, exigerEmailVerifie, (req, res) => {
  const u = req.utilisateur;
  let banniere = "";
  if (u.statutVerification === "profil_incomplet") {
    banniere = `<div class="banniere banniere-attente">Complétez votre profil et votre pièce d'identité pour pouvoir recharger votre Alipay.<a class="bouton" href="/compte/profil">Compléter mon profil</a></div>`;
  } else if (u.statutVerification === "en_attente") {
    banniere = `<div class="banniere banniere-attente">Votre profil est en cours de vérification. Vous pourrez faire une recharge dès que ce sera fait.</div>`;
  } else if (u.statutVerification === "refuse") {
    banniere = `<div class="banniere banniere-erreur">${u.raisonRefus || MESSAGE_REFUS_IDENTITE}<a class="bouton danger" href="/compte/profil">Mettre à jour mon profil</a></div>`;
  }

  const mesTransactions = transactions.filter((t) => t.utilisateurId === u.id).slice(-2).reverse();
  const activites = mesTransactions
    .map((t) => {
      const s = statutTransactionAffiche(t.statut);
      return `<div class="item-historique"><div class="titre-item"><span>Recharge Alipay — ${t.montantRMB} RMB</span><span class="badge ${s.classe}">${s.texte}</span></div><span style="color:var(--texte-att); font-size:12px;">${t.reference}</span></div>`;
    })
    .join("");

  const contenu = `
    ${entete("accueil", u)}
    <h1>Salut, ${nomAffichage(u)}</h1>
    <p class="souligne">Ravi de vous revoir sur ${CONFIG.NOM_SITE}.</p>
    ${banniere}
    <div class="taux-boite">
      <span>Le Yuan à partir de</span>
      <b>93 F CFA</b>
      <span style="display:block; margin-top:6px; text-transform:none; letter-spacing:0; font-size:14.5px; font-weight:700; color:var(--jaune);">Plus vous achetez, plus le taux baisse !</span>
    </div>
    ${u.statutVerification === "verifie" ? `<a class="bouton jaune" href="/compte/nouvelle-demande">Recharger mon Alipay</a>` : ""}
    <div class="carte" style="margin-top:18px;">
      <h2>Dernières activités</h2>
      ${mesTransactions.length === 0 ? `<p class="aucune-donnee">Aucune activité pour le moment.</p>` : activites}
      ${mesTransactions.length > 0 ? `<a class="lien-discret" href="/compte/historique">Voir tout →</a>` : ""}
    </div>
  `;
  res.send(page("Mon compte", contenu));
});

// ============================================================================
// 9) ESPACE PERSONNEL — PROFIL
// ============================================================================
app.get("/compte/profil", exigerConnexion, exigerEmailVerifie, (req, res) => {
  const u = req.utilisateur;
  const modifiable = u.statutVerification === "profil_incomplet" || u.statutVerification === "refuse";

  let blocIdentite;
  if (modifiable) {
    const indicatifOptions = PAYS.map((p) => `<option value="${p.indicatif}" data-chiffres="${p.chiffres}">${p.nom} (${p.indicatif})</option>`).join("");
    blocIdentite = `
      <div class="carte">
        <h2>Informations personnelles</h2>
        ${u.statutVerification === "refuse" ? `<div class="banniere banniere-erreur">${u.raisonRefus || MESSAGE_REFUS_IDENTITE}</div>` : ""}
        <form method="POST" action="/compte/profil" enctype="multipart/form-data">
          <label for="prenom">Prénom (identique à votre pièce d'identité)</label>
          <input type="text" id="prenom" name="prenom" value="${u.prenom || ""}" required>

          <label for="nom">Nom (identique à votre pièce d'identité)</label>
          <input type="text" id="nom" name="nom" value="${u.nom || ""}" required>

          <label id="labelTelephone">Numéro de téléphone</label>
          <div style="display:flex; gap:8px;">
            <select name="indicatif" id="selectPays" required onchange="majFormatTelephone()">
              <option value="" selected disabled>Sélectionnez un pays</option>
              ${indicatifOptions}
            </select>
            <input type="text" id="champTelephone" name="numeroTelephone" placeholder="Sélectionnez d'abord un pays" inputmode="numeric" oninput="this.value=this.value.replace(/\D/g,'').slice(0,this.maxLength||20)" required disabled>
          </div>

          <label for="pieceIdentite">Pièce d'identité (JPG, JPEG, PNG ou PDF — max 2 Mo)</label>
          <div class="zone-fichier">
            <input type="file" id="pieceIdentite" name="pieceIdentite" accept=".jpg,.jpeg,.png,.pdf" required>
            <p class="indice">Document lisible et complet</p>
          </div>
          <button type="submit">Envoyer pour vérification</button>
        </form>
        <script>
          function majFormatTelephone() {
            const select = document.getElementById('selectPays');
            const champ = document.getElementById('champTelephone');
            const option = select.options[select.selectedIndex];
            const chiffres = parseInt(option.getAttribute('data-chiffres'), 10);
            if (!chiffres) return;
            champ.disabled = false;
            champ.maxLength = chiffres;
            champ.setAttribute('pattern', '[0-9]{' + chiffres + '}');
            champ.placeholder = chiffres + ' chiffres, ex : ' + '9'.repeat(chiffres);
            champ.value = champ.value.replace(/\\D/g, '').slice(0, chiffres);
          }
        </script>
      </div>`;
  } else {
    const badgeClasse = u.statutVerification === "verifie" ? "badge-verifie" : "badge-attente";
    const badgeTexte = u.statutVerification === "verifie" ? "Vérifié" : "En attente de vérification";
    blocIdentite = `
      <div class="carte">
        <h2>Informations personnelles <span class="badge ${badgeClasse}">${badgeTexte}</span></h2>
        <div class="ligne"><span>Prénom</span><b>${u.prenom}</b></div>
        <div class="ligne"><span>Nom</span><b>${u.nom}</b></div>
        <div class="ligne"><span>Téléphone</span><b>${u.telephone}</b></div>
        <div class="ligne"><span>Pièce d'identité</span><b>${u.statutVerification === "verifie" ? "Vérifiée" : "Envoyée"}</b></div>
      </div>`;
  }

  const contenu = `
    ${entete("profil", u)}
    <h1>Mon profil</h1>
    ${blocIdentite}
    <div class="carte">
      <h2>Adresse e-mail</h2>
      <div class="ligne"><span>E-mail vérifié</span><b>${u.identifiant}</b></div>
      <p class="souligne" style="margin-top:10px;">Pour des raisons de sécurité, l'adresse e-mail d'un compte ne peut pas être modifiée après vérification. Contactez le support si besoin.</p>
    </div>
    <div class="carte">
      <h2>Sécurité</h2>
      <p class="souligne">Laissez vide si vous ne souhaitez pas changer votre mot de passe.</p>
      <form method="POST" action="/compte/profil/mot-de-passe">
        <label for="nouveauMdp">Nouveau mot de passe</label>
        <input type="password" id="nouveauMdp" name="nouveauMdp" minlength="8">
        <label for="confirmerMdp">Confirmer</label>
        <input type="password" id="confirmerMdp" name="confirmerMdp" minlength="8">
        ${caseAfficherMdp(["nouveauMdp", "confirmerMdp"])}
        <button type="submit" class="fantome">Mettre à jour le mot de passe</button>
      </form>
    </div>
    <div class="carte" style="border-color: var(--rouge);">
      <h2 style="color:var(--rouge);">Zone de danger</h2>
      <p class="souligne">La suppression de votre compte est définitive et irréversible.</p>
      <a class="bouton danger" href="/compte/supprimer-compte">Supprimer mon compte</a>
    </div>
  `;
  res.send(page("Mon profil", contenu));
});

app.post("/compte/profil", exigerConnexion, exigerEmailVerifie, uploadIdentite.single("pieceIdentite"), async (req, res) => {
  const u = req.utilisateur;
  const { nom, prenom, indicatif, numeroTelephone } = req.body;
  const piece = req.file;
  if (!nom || !prenom || !indicatif || !numeroTelephone || !piece) {
    return res.status(400).send(page("Erreur", `<h1>Merci de remplir tous les champs</h1><a href="/compte/profil">← Retour</a>`));
  }
  let reference, estPdf;
  try {
    ({ reference, estPdf } = await traiterFichierUploade(piece, "identite"));
  } catch (erreur) {
    console.error("Erreur upload pièce d'identité :", erreur.message);
    return res.status(500).send(page("Erreur", `<h1>Échec de l'envoi du fichier</h1><p class="souligne">Le service de stockage a rencontré un problème. Merci de réessayer dans un instant.</p><a href="/compte/profil">← Réessayer</a>`));
  }
  u.nom = nom;
  u.prenom = prenom;
  u.telephone = `${indicatif} ${numeroTelephone}`;
  u.pieceIdentite = reference;
  u.pieceIdentiteEstPdf = estPdf;
  u.raisonRefus = null;
  // Le numéro de téléphone n'est pas vérifié par SMS : il est simplement
  // renseigné. C'est la pièce d'identité qui est vérifiée par l'admin.
  u.statutVerification = "en_attente";
  sauvegarderJSON(FICHIER_UTILISATEURS, utilisateurs);
  envoyerNotificationPush(
    "Nouveau compte à vérifier",
    `${prenom} ${nom} attend une vérification d'identité.`,
    "/admin/utilisateurs"
  ).catch(() => {});
  res.redirect("/compte");
});

// La vérification du numéro de téléphone par SMS a été retirée : le numéro
// est simplement renseigné dans le profil, sans confirmation par code.

// L'e-mail est vérifié une seule fois à l'inscription et ne peut plus être
// changé ensuite (routes de changement d'e-mail volontairement supprimées).

app.post("/compte/profil/mot-de-passe", exigerConnexion, exigerEmailVerifie, (req, res) => {
  const { nouveauMdp, confirmerMdp } = req.body;
  if (!nouveauMdp) return res.redirect("/compte/profil");
  if (nouveauMdp !== confirmerMdp) return res.status(400).send(page("Erreur", `<h1>Les mots de passe ne correspondent pas</h1><a href="/compte/profil">← Retour</a>`));
  if (!motDePasseRobuste(nouveauMdp)) {
    return res.status(400).send(page("Erreur", `<h1>Mot de passe trop faible</h1><p class="souligne">Au moins 8 caractères, une majuscule, une minuscule et un chiffre.</p><a href="/compte/profil">← Retour</a>`));
  }
  const { sel, hash } = hacherMotDePasse(nouveauMdp);
  req.utilisateur.motDePasseSel = sel;
  req.utilisateur.motDePasseHash = hash;
  sauvegarderJSON(FICHIER_UTILISATEURS, utilisateurs);
  res.redirect("/compte/profil");
});

app.get("/compte/supprimer-compte", exigerConnexion, (req, res) => {
  const contenu = `
    ${entete("profil", req.utilisateur)}
    <h1>Supprimer mon compte</h1>
    <div class="banniere banniere-erreur">Vous n'aurez plus accès à votre compte après cette action. Vos transactions passées sont conservées dans nos archives, comme l'exigent nos obligations légales et comptables (voir nos CGU/CGV).</div>
    <form method="POST" action="/compte/supprimer-compte">
      <button type="submit" class="danger">Oui, supprimer mon compte</button>
    </form>
    <a class="lien-discret" href="/compte/profil">← Annuler</a>
  `;
  res.send(page("Supprimer mon compte", contenu));
});
app.post("/compte/supprimer-compte", exigerConnexion, (req, res) => {
  // On n'efface pas le compte : on révoque simplement son accès. Ses
  // informations, transactions et notifications restent dans la base,
  // archivées, pour la comptabilité et les obligations légales.
  const u = req.utilisateur;
  u.compteSupprime = true;
  u.dateSuppressionCompte = new Date().toISOString();
  sauvegarderJSON(FICHIER_UTILISATEURS, utilisateurs);
  deconnecterUtilisateur(req, res);
  res.redirect("/connexion");
});

// ============================================================================
// 10) NOUVELLE DEMANDE DE RECHARGE (3 étapes)
// ============================================================================
function exigerVerifie(req, res, next) {
  if (!req.utilisateur) return res.redirect("/connexion");
  if (req.utilisateur.statutVerification !== "verifie") return res.redirect("/compte");
  next();
}
const ETAPES = ["Montant & QR", "Moyen de paiement", "Confirmation"];

app.get("/compte/nouvelle-demande", exigerConnexion, exigerEmailVerifie, exigerVerifie, (req, res) => {
  const montantPrecedent = req.query.montantRMB || "";
  const imagePrecedente = req.query.alipayImage || "";
  const contenu = `
    ${entete("accueil", req.utilisateur)}
    ${stepper(1, ETAPES)}
    <h1>Recharger mon Alipay</h1>
    <p class="souligne">Minimum : ${CONFIG.MONTANT_MIN_RMB} RMB</p>
    <div class="carte">
      <form method="POST" action="/compte/nouvelle-demande" enctype="multipart/form-data">
        <label for="montantRMB">Montant à recevoir sur Alipay (RMB)</label>
        <input type="number" id="montantRMB" name="montantRMB" min="${CONFIG.MONTANT_MIN_RMB}" step="0.01" required oninput="majApercu()" value="${montantPrecedent}">
        <p class="souligne" id="apercuMontant" style="margin:6px 0 0;">Indiquez un montant pour voir le taux et le total.</p>
        <p id="astuceMontant" style="display:none; background: rgba(245,158,11,0.1); border: 1px solid rgba(245,158,11,0.3); color: #FBBF6B; border-radius: 8px; padding: 8px 12px; font-size: 12.5px; margin: 8px 0 0;"></p>

        <label for="alipayImage">Code QR de votre profil Alipay</label>
        <div class="avertissement">⚠️ Le compte Alipay doit être <b>vérifié</b>, sinon Alipay peut bloquer les fonds et ${CONFIG.NOM_SITE} ne pourra pas intervenir.</div>
        <div class="zone-fichier">
          ${imagePrecedente ? `<img src="${imagePrecedente.startsWith("http") ? imagePrecedente : "/uploads/alipay/" + imagePrecedente}" alt="QR déjà envoyé" style="max-width:150px; border-radius:8px; margin-bottom:8px; display:block;">` : ""}
          <input type="file" id="alipayImage" name="alipayImage" accept="image/*" ${imagePrecedente ? "" : "required"}>
          <p class="indice">${imagePrecedente ? "Image déjà envoyée ci-dessus. Laissez vide pour la conserver, ou choisissez-en une nouvelle." : "Ouvrez Alipay → recevoir de l'argent → capture du QR code (max 2 Mo)"}</p>
        </div>
        <input type="hidden" name="alipayImagePrecedente" value="${imagePrecedente}">
        <button type="submit">Continuer</button>
      </form>
    </div>
    <script>
      const PALIERS = ${JSON.stringify(CONFIG.PALIERS_TAUX)};
      const FRAIS_POURCENT = ${CONFIG.FRAIS_POURCENT};

      function tauxPour(montant) {
        for (const p of PALIERS) if (montant <= p.seuilMax) return p;
        return PALIERS[PALIERS.length - 1];
      }

      function majApercu() {
        const v = parseFloat(document.getElementById('montantRMB').value);
        const apercu = document.getElementById('apercuMontant');
        const astuce = document.getElementById('astuceMontant');
        if (!v || v <= 0) {
          apercu.textContent = 'Indiquez un montant pour voir le taux et le total.';
          astuce.style.display = 'none';
          return;
        }
        const palier = tauxPour(v);
        const cfa = Math.round(v * palier.taux);
        const fraisXOF = Math.round(cfa * FRAIS_POURCENT / 100);
        const total = cfa + fraisXOF;
        apercu.textContent = 'Taux : ' + palier.taux + ' F CFA/Yuan — Total : ' + total.toLocaleString('fr-FR') + ' F CFA'
          + (FRAIS_POURCENT > 0 ? ' (frais de ' + FRAIS_POURCENT + '% inclus)' : ' (aucun frais de service)');

        // Astuce incitative : si un palier meilleur existe juste au-dessus.
        const indexActuel = PALIERS.indexOf(palier);
        const palierSuivant = PALIERS[indexActuel + 1];
        if (palierSuivant) {
          const seuilProchain = palier.seuilMax + 0.01;
          const manque = Math.ceil(seuilProchain - v);
          if (manque > 0 && manque <= 150) {
            astuce.style.display = 'block';
            astuce.textContent = '💡 Astuce : ajoutez encore ' + manque + ' RMB pour débloquer le tarif préférentiel à ' + palierSuivant.taux + ' F CFA/Yuan !';
          } else {
            astuce.style.display = 'none';
          }
        } else {
          astuce.style.display = 'none';
        }
      }
      if (${montantPrecedent ? "true" : "false"}) majApercu();
    </script>
    ${grilleTarifaireHTML()}
  `;
  res.send(page("Nouvelle recharge", contenu));
});
function pageMoyenPaiement(req, montant, referenceImage, moyenPrecedent = "", numeroPrecedent = "") {
  const estTogo = (req.utilisateur.telephone || "").trim().startsWith("+228");
  const optionsPaiement = Object.entries(CONFIG.PAIEMENT)
    .filter(([, info]) => estTogo || !info.togoUniquement)
    .map(([cle, info]) => `
      <label class="moyen-option${cle === moyenPrecedent ? " selectionne" : ""}" data-cle="${cle}" data-type="${info.typeSaisie}" onclick="selectionnerMoyen(this)">
        <input type="radio" name="moyenPaiement" value="${cle}" ${cle === moyenPrecedent ? "checked" : ""} required>
        ${info.logo ? `<img src="/logos/${info.logo}" alt="" style="width:50px; height:50px; object-fit:contain; border-radius:2px;">` : ""}
        <span>${info.nom}</span>
      </label>`)
    .join("");

  return `
    ${entete("accueil", req.utilisateur)}
    ${stepper(2, ETAPES)}
    <h1>Moyen de paiement</h1>
    <p class="souligne">Sélectionnez votre méthode de paiement préférée.${!estTogo ? " Mixx By Yas et Moov Money sont réservés aux numéros togolais." : ""}</p>
    <div class="carte">
      <form method="POST" action="/compte/choisir-paiement">
        <input type="hidden" name="montantRMB" value="${montant}">
        <input type="hidden" name="alipayImage" value="${referenceImage}">
        ${optionsPaiement}

        <label for="numeroExpediteur" id="labelNumeroExpediteur">Numéro ou compte utilisé pour le dépôt</label>
        <input type="text" id="numeroExpediteur" name="numeroExpediteur" placeholder="Sélectionnez d'abord un moyen de paiement" value="${numeroPrecedent}" required>
        <div class="avertissement">⚠️ Important : le numéro Mobile Money, le compte bancaire ou le compte PI-SPI utilisé pour cette transaction doit être enregistré au <b>même nom</b> que votre profil ${CONFIG.NOM_SITE}. En cas de nom différent, l'opération peut échouer.</div>

        <button type="submit">Continuer</button>
      </form>
      <a class="lien-discret" href="/compte/nouvelle-demande?montantRMB=${montant}&alipayImage=${encodeURIComponent(referenceImage)}">← Précédent</a>
    </div>
    <script>
      function selectionnerMoyen(labelClique) {
        document.querySelectorAll('.moyen-option').forEach(l => l.classList.remove('selectionne'));
        labelClique.classList.add('selectionne');

        const type = labelClique.getAttribute('data-type');
        const champ = document.getElementById('numeroExpediteur');
        const label = document.getElementById('labelNumeroExpediteur');
        if (type === 'telephone') {
          label.textContent = 'Numéro utilisé pour le dépôt (8 chiffres)';
          champ.type = 'tel';
          champ.setAttribute('inputmode', 'numeric');
          champ.setAttribute('pattern', '[0-9]{8}');
          champ.maxLength = 8;
          champ.placeholder = 'ex : 92908235';
          champ.value = champ.value.replace(/\\D/g, '').slice(0, 8);
          champ.oninput = function () { this.value = this.value.replace(/\\D/g, '').slice(0, 8); };
        } else {
          label.textContent = 'Nom complet du compte utilisé pour le dépôt';
          champ.type = 'text';
          champ.removeAttribute('inputmode');
          champ.removeAttribute('pattern');
          champ.removeAttribute('maxLength');
          champ.placeholder = 'ex : Jean Dupont';
          champ.value = champ.value.replace(/[0-9]/g, '');
          champ.oninput = function () { this.value = this.value.replace(/[0-9]/g, ''); };
        }
      }
      ${moyenPrecedent ? `const optionActive = document.querySelector('.moyen-option[data-cle="${moyenPrecedent}"]'); if (optionActive) selectionnerMoyen(optionActive);` : ""}
    </script>
  `;
}

app.get("/compte/nouvelle-demande/paiement", exigerConnexion, exigerEmailVerifie, exigerVerifie, (req, res) => {
  const montant = parseFloat(req.query.montantRMB);
  const referenceImage = req.query.alipayImage;
  if (!montant || !referenceImage) return res.redirect("/compte/nouvelle-demande");
  res.send(page("Moyen de paiement", pageMoyenPaiement(req, montant, referenceImage, req.query.moyenPaiement || "", req.query.numeroExpediteur || "")));
});
app.post("/compte/nouvelle-demande", exigerConnexion, exigerEmailVerifie, exigerVerifie, uploadAlipay.single("alipayImage"), async (req, res) => {
  const montant = parseFloat(req.body.montantRMB);
  const image = req.file;
  const imagePrecedente = req.body.alipayImagePrecedente || "";
  if (!montant || montant < CONFIG.MONTANT_MIN_RMB || (!image && !imagePrecedente)) {
    return res.status(400).send(page("Erreur", `<h1>Montant invalide</h1><p class="souligne">Le minimum est de ${CONFIG.MONTANT_MIN_RMB} RMB et une image est requise.</p><a href="/compte/nouvelle-demande">← Retour</a>`));
  }
  let referenceImage = imagePrecedente;
  if (image) {
    try {
      ({ reference: referenceImage } = await traiterFichierUploade(image, "alipay"));
    } catch (erreur) {
      console.error("Erreur upload QR Alipay :", erreur.message);
      return res.status(500).send(page("Erreur", `<h1>Échec de l'envoi du fichier</h1><p class="souligne">Le service de stockage a rencontré un problème. Merci de réessayer dans un instant.</p><a href="/compte/nouvelle-demande">← Réessayer</a>`));
    }
  }

  res.send(page("Moyen de paiement", pageMoyenPaiement(req, montant, referenceImage)));
});

// Étape 3 : simple récapitulatif — RIEN n'est encore enregistré. Le clic sur
// "J'ai payé" (voir plus bas) est ce qui crée réellement la transaction.
app.post("/compte/choisir-paiement", exigerConnexion, exigerEmailVerifie, exigerVerifie, (req, res) => {
  const { montantRMB, alipayImage, moyenPaiement, numeroExpediteur } = req.body;
  const montant = parseFloat(montantRMB);
  const info = CONFIG.PAIEMENT[moyenPaiement];
  if (!montant || !alipayImage || !info || !numeroExpediteur) {
    return res.status(400).send(page("Erreur", `<h1>Requête invalide</h1><a href="/compte/nouvelle-demande">← Recommencer</a>`));
  }
  if (info.togoUniquement && !(req.utilisateur.telephone || "").trim().startsWith("+228")) {
    return res.status(400).send(page("Erreur", `<h1>Moyen de paiement indisponible</h1><p class="souligne">Mixx By Yas et Moov Money sont réservés aux comptes avec un numéro togolais. Utilisez Ecobank ou PI-SPI.</p><a href="/compte/nouvelle-demande">← Recommencer</a>`));
  }
  if (info.typeSaisie === "telephone" && !/^\d{8}$/.test(numeroExpediteur.trim())) {
    return res.status(400).send(page("Erreur", `<h1>Numéro invalide</h1><p class="souligne">Le numéro utilisé pour le dépôt doit contenir exactement 8 chiffres.</p><a href="/compte/nouvelle-demande">← Recommencer</a>`));
  }
  if (info.typeSaisie === "nom" && numeroExpediteur.trim().length < 3) {
    return res.status(400).send(page("Erreur", `<h1>Nom invalide</h1><p class="souligne">Merci d'indiquer le nom complet du compte utilisé pour le dépôt.</p><a href="/compte/nouvelle-demande">← Recommencer</a>`));
  }

  const tauxApplique = tauxPourMontant(montant);
  const montantCFA = Math.round(montant * tauxApplique);
  const frais = Math.round((montantCFA * CONFIG.FRAIS_POURCENT) / 100);
  const total = montantCFA + frais;

  const contenu = `
    ${entete("accueil", req.utilisateur)}
    ${stepper(3, ETAPES)}
    <h1>Confirmation</h1>
    <div class="carte">
      <div class="ligne"><span>Service</span><b>Alipay</b></div>
      <div class="ligne"><span>Taux appliqué</span><b>1 RMB = ${tauxApplique} XOF</b></div>
      <div class="ligne"><span>Le bénéficiaire reçoit</span><b>${montant} RMB</b></div>
      ${frais > 0 ? `<div class="ligne"><span>Frais de service (${CONFIG.FRAIS_POURCENT}%)</span><b>+ ${frais.toLocaleString("fr-FR")} XOF</b></div>` : ""}
      <div class="ligne"><span>Via</span><b>${info.nom}</b></div>
      <div class="ligne"><span>Numéro utilisé pour le dépôt</span><b>${numeroExpediteur}</b></div>
      <div class="ligne"><span>Total à payer</span><b style="font-size:18px; color:var(--jaune);">${total.toLocaleString("fr-FR")} XOF</b></div>

      <p class="souligne" style="margin:14px 0 0;">Voici le numéro sur lequel il faut transférer les fonds :</p>
      <div class="boite-paiement">
        <div><small>${info.nom}</small><b id="numero-tmp">${info.numero}</b><span class="nom-titulaire">Titulaire : ${CONFIG.NOM_TITULAIRE_COMPTE}</span></div>
        <button type="button" class="btn-copier" onclick="copierTexte('numero-tmp')">Copier</button>
      </div>
      ${info.noteFrais ? `<div class="avertissement">⚠️ Important : ne pas ajouter les frais de retrait lors de votre dépôt.</div>` : ""}

      <form method="POST" action="/compte/finaliser-commande">
        <input type="hidden" name="montantRMB" value="${montant}">
        <input type="hidden" name="alipayImage" value="${alipayImage}">
        <input type="hidden" name="moyenPaiement" value="${moyenPaiement}">
        <input type="hidden" name="numeroExpediteur" value="${numeroExpediteur}">
        <label style="display:flex; align-items:flex-start; gap:8px; text-transform:none; font-weight:400; color:var(--texte-att); margin-top:14px; font-size:13px;">
          <input type="checkbox" name="cguTransaction" value="oui" style="width:auto; margin-top:2px;" required>
          <span>Je confirme avoir lu et j'accepte les <a href="/conditions-utilisation" target="_blank" class="souligne">Conditions Générales d'Utilisation et de Vente (CGU/CGV)</a>, notamment concernant la correspondance de nom du compte utilisé pour le dépôt.</span>
        </label>
        <button type="submit" class="jaune">J'ai payé</button>
      </form>
      <a class="lien-discret" href="/compte/nouvelle-demande/paiement?montantRMB=${montant}&alipayImage=${encodeURIComponent(alipayImage)}&moyenPaiement=${encodeURIComponent(moyenPaiement)}&numeroExpediteur=${encodeURIComponent(numeroExpediteur)}">← Précédent</a>
    </div>
  `;
  res.send(page("Confirmation", contenu));
});

// C'est cette étape qui crée réellement la transaction. Si le client
// abandonne avant, rien n'est enregistré : il repart de zéro.
app.post("/compte/finaliser-commande", exigerConnexion, exigerEmailVerifie, exigerVerifie, (req, res) => {
  const { montantRMB, alipayImage, moyenPaiement, numeroExpediteur, cguTransaction } = req.body;
  const montant = parseFloat(montantRMB);
  if (!montant || !alipayImage || !CONFIG.PAIEMENT[moyenPaiement] || !numeroExpediteur) {
    return res.status(400).send(page("Erreur", `<h1>Requête invalide</h1><a href="/compte/nouvelle-demande">← Recommencer</a>`));
  }
  if (cguTransaction !== "oui") {
    return res.status(400).send(page("Erreur", `<h1>Acceptation des CGU/CGV requise</h1><p class="souligne">Vous devez cocher la case d'acceptation des Conditions Générales d'Utilisation et de Vente pour valider votre paiement.</p><a href="/compte/nouvelle-demande">← Recommencer</a>`));
  }

  const tauxApplique = tauxPourMontant(montant);
  const montantCFA = Math.round(montant * tauxApplique);
  const frais = Math.round((montantCFA * CONFIG.FRAIS_POURCENT) / 100);
  const total = montantCFA + frais;
  const reference = genererReference();

  const transaction = {
    reference,
    utilisateurId: req.utilisateur.id,
    identifiantUtilisateur: req.utilisateur.identifiant,
    nomUtilisateur: nomAffichage(req.utilisateur),
    prenomNomComplet: `${req.utilisateur.prenom || ""} ${req.utilisateur.nom || ""}`.trim(),
    alipayImage,
    montantRMB: montant,
    tauxApplique,
    montantCFA,
    frais,
    total,
    moyenPaiement,
    numeroExpediteur,
    imagePaiement: null,
    fichePDF: null,
    recuPDF: null,
    raisonAnnulation: null,
    // en_attente_paiement -> preuve_recue -> paye -> effectue | annule
    statut: "en_attente_paiement",
    dateCreation: new Date().toISOString(),
  };
  transactions.push(transaction);
  sauvegarderJSON(FICHIER_TRANSACTIONS, transactions);
  res.redirect(`/compte/transactions/${reference}/preuve`);
});

// ============================================================================
// 11) DÉTAIL D'UNE TRANSACTION (instructions / preuve / récapitulatif)
// ============================================================================
app.get("/compte/transactions/:reference", exigerConnexion, exigerEmailVerifie, (req, res) => {
  const t = transactions.find((x) => x.reference === req.params.reference && x.utilisateurId === req.utilisateur.id);
  if (!t) return res.status(404).send(page("Introuvable", `<h1>Transaction introuvable</h1><a href="/compte">← Retour</a>`));

  let contenuSpecifique;

  if (t.statut === "en_attente_paiement") {
    const info = CONFIG.PAIEMENT[t.moyenPaiement];
    contenuSpecifique = `
      ${stepper(3, ETAPES)}
      <h1>Confirmation</h1>
      <div class="carte">
        <div class="ligne"><span>Service</span><b>Alipay</b></div>
        <div class="ligne"><span>Taux appliqué</span><b>1 RMB = ${t.tauxApplique || CONFIG.PALIERS_TAUX[CONFIG.PALIERS_TAUX.length - 1].taux} XOF</b></div>
        <div class="ligne"><span>Le bénéficiaire reçoit</span><b>${t.montantRMB} RMB</b></div>
        ${t.frais > 0 ? `<div class="ligne"><span>Frais de service</span><b>+ ${t.frais.toLocaleString("fr-FR")} XOF</b></div>` : ""}
        <div class="ligne"><span>Via</span><b>${info.nom}</b></div>
        <div class="ligne"><span>Total à payer</span><b style="font-size:18px; color:var(--jaune);">${t.total.toLocaleString("fr-FR")} XOF</b></div>

        <p class="souligne" style="margin:14px 0 0;">Voici le numéro sur lequel il faut transférer les fonds :</p>
        <div class="boite-paiement">
          <div><small>${info.nom}</small><b id="numero-${t.reference}">${info.numero}</b><span class="nom-titulaire">Titulaire : ${CONFIG.NOM_TITULAIRE_COMPTE}</span></div>
          <button type="button" class="btn-copier" onclick="copierTexte('numero-${t.reference}')">Copier</button>
        </div>
        ${info.noteFrais ? `<div class="avertissement">⚠️ Important : ne pas ajouter les frais de retrait lors de votre dépôt.</div>` : ""}

        <form method="GET" action="/compte/transactions/${t.reference}/preuve">
          <label style="display:flex; align-items:flex-start; gap:8px; text-transform:none; font-weight:400; color:var(--texte-att); margin-top:14px; font-size:13px;">
            <input type="checkbox" name="cguTransaction" value="oui" style="width:auto; margin-top:2px;" required>
            <span>Je confirme avoir lu et j'accepte les <a href="/conditions-utilisation" target="_blank" class="souligne">Conditions Générales d'Utilisation et de Vente (CGU/CGV)</a>, notamment concernant la correspondance de nom du compte utilisé pour le dépôt.</span>
          </label>
          <button type="submit" class="jaune">J'ai payé</button>
        </form>
      </div>
    `;
  } else if (t.statut === "preuve_recue" || t.statut === "paye") {
    contenuSpecifique = `
      <h1>Transfert vers Alipay</h1>
      <div class="carte">
        <div class="banniere banniere-attente">Paiement reçu et en cours de traitement. Vous recevrez une notification dès que la transaction sera complétée.</div>
        <div class="ligne"><span>Montant envoyé</span><b>${t.total.toLocaleString("fr-FR")} XOF</b></div>
        <div class="ligne"><span>Montant à recevoir</span><b>¥ ${t.montantRMB}</b></div>
        <div class="ligne"><span>Référence</span><b>${t.reference}</b></div>
        <div class="tracker">
          <div class="pt fait"><div class="rond">✓</div><span>Initié</span></div>
          <div class="pt fait"><div class="rond">✓</div><span>Payé</span></div>
          <div class="pt ${t.statut === "paye" ? "fait" : ""}"><div class="rond">${t.statut === "paye" ? "✓" : "3"}</div><span>Traitement</span></div>
          <div class="pt"><div class="rond">4</div><span>Complété</span></div>
        </div>
        <p class="souligne">Une question sur cette transaction ? Contactez-nous par e-mail (${CONFIG.CONTACT_EMAIL}) ou WhatsApp.</p>
      </div>
    `;
  } else if (t.statut === "effectue") {
    contenuSpecifique = `
      <h1>Transfert vers Alipay</h1>
      <div class="carte">
        <div class="banniere banniere-succes">Transaction complétée avec succès ✔ Votre compte Alipay a été crédité.</div>
        <div class="ligne"><span>Montant envoyé</span><b>${t.total.toLocaleString("fr-FR")} XOF</b></div>
        <div class="ligne"><span>Montant reçu</span><b>¥ ${t.montantRMB}</b></div>
        <div class="ligne"><span>Référence</span><b>${t.reference}</b></div>
        ${t.recuPDF ? `<a class="bouton jaune" href="${hrefFichier(t.recuPDF, "recus")}" target="_blank">Télécharger le reçu</a>` : ""}
      </div>
    `;
  } else {
    contenuSpecifique = `
      <h1>Transfert vers Alipay</h1>
      <div class="carte">
        <div class="banniere banniere-erreur">${t.raisonAnnulation || MESSAGE_PAIEMENT_ANNULE}</div>
        <div class="ligne"><span>Référence</span><b>${t.reference}</b></div>
        <a class="bouton fantome" href="mailto:${CONFIG.CONTACT_EMAIL}">Nous écrire par e-mail</a>
        <a class="bouton jaune" href="https://wa.me/${CONFIG.CONTACT_WHATSAPP}" target="_blank">Discuter sur WhatsApp</a>
      </div>
    `;
  }

  res.send(page("Transaction", `${entete("accueil", req.utilisateur)}${contenuSpecifique}`));
});

app.get("/compte/transactions/:reference/preuve", exigerConnexion, exigerEmailVerifie, (req, res) => {
  const t = transactions.find((x) => x.reference === req.params.reference && x.utilisateurId === req.utilisateur.id);
  if (!t || t.statut !== "en_attente_paiement") return res.redirect(`/compte/transactions/${req.params.reference}`);
  const contenu = `
    ${entete("accueil", req.utilisateur)}
    <h1>Finaliser la commande</h1>
    <div class="carte">
      <form method="POST" action="/compte/transactions/${t.reference}/preuve-paiement" enctype="multipart/form-data">
        <label for="imagePaiement">Preuve de paiement (reçu / capture d'écran)</label>
        <div class="zone-fichier">
          <input type="file" id="imagePaiement" name="imagePaiement" accept=".jpg,.jpeg,.png,.pdf" required>
          <p class="indice">JPEG, PNG ou PDF (Max 2 Mo)</p>
        </div>
        <button type="submit">Confirmer</button>
      </form>
      <a class="lien-discret" href="/compte/transactions/${t.reference}">Annuler</a>
    </div>
  `;
  res.send(page("Finaliser la commande", contenu));
});

app.post("/compte/transactions/:reference/preuve-paiement", exigerConnexion, exigerEmailVerifie, uploadPreuve.single("imagePaiement"), async (req, res) => {
  const t = transactions.find((x) => x.reference === req.params.reference && x.utilisateurId === req.utilisateur.id);
  if (!t || t.statut !== "en_attente_paiement") return res.status(404).send(page("Introuvable", `<h1>Transaction introuvable</h1><a href="/compte">← Retour</a>`));
  if (!req.file) return res.status(400).send(page("Erreur", `<h1>Merci de joindre une preuve de paiement</h1><a href="/compte/transactions/${t.reference}/preuve">← Retour</a>`));

  let referencePreuve, estPdf;
  try {
    ({ reference: referencePreuve, estPdf } = await traiterFichierUploade(req.file, "preuves"));
  } catch (erreur) {
    console.error("Erreur upload preuve de paiement :", erreur.message);
    return res.status(500).send(page("Erreur", `<h1>Échec de l'envoi du fichier</h1><p class="souligne">Le service de stockage a rencontré un problème. Merci de réessayer dans un instant.</p><a href="/compte/transactions/${t.reference}/preuve">← Réessayer</a>`));
  }
  t.imagePaiement = referencePreuve;
  t.imagePaiementEstPdf = estPdf;
  t.statut = "preuve_recue";
  t.datePreuve = new Date().toISOString();
  // La fiche interne n'est créée qu'après confirmation par l'admin (pas ici).
  sauvegarderJSON(FICHIER_TRANSACTIONS, transactions);
  ajouterNotification(t.utilisateurId, `Preuve de paiement reçue pour votre recharge de ${t.montantRMB} RMB. En attente de confirmation.`, t.reference);
  envoyerNotificationPush(
    "Nouvelle preuve de paiement",
    `${t.nomUtilisateur} — ${t.montantRMB} RMB (réf. ${t.reference})`,
    "/admin/transactions"
  ).catch(() => {});
  // ➕ AJOUT : Envoi de l'e-mail de confirmation de réception
  envoyerEmailTransaction(
    t.identifiantUtilisateur,
    `Preuve reçue — Commande ${t.reference}`,
    `Nous avons bien reçu votre preuve de paiement pour la commande <b>${t.reference}</b> (${t.montantRMB} RMB). Notre équipe vérifie votre dépôt.`
  ).catch((err) => console.error("Erreur e-mail preuve :", err.message));
  res.redirect(`/compte/transactions/${t.reference}`);
});

// ============================================================================
// 11bis) NOTIFICATIONS
// ============================================================================
app.get("/compte/notifications", exigerConnexion, exigerEmailVerifie, (req, res) => {
  const mesNotifs = notifications.filter((n) => n.utilisateurId === req.utilisateur.id).reverse();
  mesNotifs.forEach((n) => (n.lu = true));
  sauvegarderJSON(FICHIER_NOTIFICATIONS, notifications);

  const items = mesNotifs
    .map(
      (n) => `
      <a class="item-historique" href="${n.reference ? `/compte/transactions/${n.reference}` : "#"}">
        <div class="titre-item"><span>${n.message}</span></div>
        <p class="souligne" style="margin:4px 0 0;">${new Date(n.date).toLocaleString("fr-FR")}</p>
      </a>`
    )
    .join("");

  const contenu = `
    ${entete("accueil", req.utilisateur)}
    <h1>Notifications</h1>
    ${mesNotifs.length === 0 ? `<p class="aucune-donnee">Aucune notification pour le moment.</p>` : items}
  `;
  res.send(page("Notifications", contenu));
});

// ============================================================================
// 12) HISTORIQUE
// ============================================================================
app.get("/compte/historique", exigerConnexion, exigerEmailVerifie, (req, res) => {
  const periode = req.query.periode || "tout";
  const maintenant = Date.now();
  const seuils = { auj: 24 * 3600 * 1000, "7j": 7 * 24 * 3600 * 1000, "30j": 30 * 24 * 3600 * 1000 };

  let mesTransactions = transactions.filter((t) => t.utilisateurId === req.utilisateur.id);
  if (seuils[periode]) mesTransactions = mesTransactions.filter((t) => maintenant - new Date(t.dateCreation).getTime() <= seuils[periode]);
  mesTransactions = [...mesTransactions].reverse();

  const items = mesTransactions
    .map((t) => {
      const s = statutTransactionAffiche(t.statut);
      return `
        <a class="item-historique" href="/compte/transactions/${t.reference}">
          <div class="titre-item"><span>↗ Transfert Alipay</span><span class="badge ${s.classe}">${s.texte}</span></div>
          <div class="ligne"><span>Montant envoyé</span><b>${t.total.toLocaleString("fr-FR")} XOF</b></div>
          <div class="ligne"><span>À recevoir</span><b>${t.montantRMB} CNY</b></div>
          <div class="ligne"><span>Référence</span><b>${t.reference}</b></div>
          <p class="souligne" style="margin:8px 0 0;">${new Date(t.dateCreation).toLocaleString("fr-FR")}</p>
        </a>`;
    })
    .join("");

  const filtre = (cle, texte) => `<a class="${periode === cle ? "actif" : ""}" href="/compte/historique?periode=${cle}">${texte}</a>`;

  const contenu = `
    ${entete("historique", req.utilisateur)}
    <h1>Historique des transactions</h1>
    <div class="filtres-date">${filtre("tout", "Tout")}${filtre("auj", "Aujourd'hui")}${filtre("7j", "7 jours")}${filtre("30j", "30 jours")}</div>
    ${mesTransactions.length === 0 ? `<p class="aucune-donnee">Aucune transaction pour le moment.</p>` : items}
  `;
  res.send(page("Historique", contenu));
});

// ============================================================================
// 13) SUPPORT
// ============================================================================
app.get("/compte/support", exigerConnexion, exigerEmailVerifie, (req, res) => {
  const contenu = `
    ${entete("support", req.utilisateur)}
    <h1>Support client</h1>
    <p class="souligne">Nous sommes là pour vous aider à tout moment.</p>

    <div class="support-tuile">
      <b>Discuter sur WhatsApp</b>
      <p class="souligne" style="margin:6px 0 12px;">Discutez instantanément avec l'un de nos gestionnaires de compte.</p>
      <a class="bouton jaune" href="https://wa.me/${CONFIG.CONTACT_WHATSAPP}" target="_blank">Démarrer la discussion</a>
    </div>
    <div class="support-tuile">
      <b>Assistance par e-mail</b>
      <p class="souligne" style="margin:6px 0 12px;">Envoyez-nous vos requêtes ou documents justificatifs.</p>
      <a class="bouton fantome" href="mailto:${CONFIG.CONTACT_EMAIL}">Nous écrire par e-mail</a>
    </div>

    <h2 style="margin-top:24px;">Foire aux questions</h2>
    <details class="faq"><summary>Combien de temps prend une recharge ?</summary><p>En général entre 15 et 45 minutes après réception de votre paiement.</p></details>
    <details class="faq"><summary>Quels moyens de paiement puis-je utiliser ?</summary><p>Mixx By Yas, Moov Money, Ecobank Togo, ou PI-SPI.</p></details>
    <details class="faq"><summary>Comment vérifier mon compte ?</summary><p>Complétez votre profil avec votre nom complet, votre téléphone et votre pièce d'identité dans l'onglet Profil.</p></details>
    <details class="faq"><summary>Mes fonds sont-ils sécurisés ?</summary><p>Chaque transaction est suivie par référence et vérifiée avant traitement.</p></details>

    <div class="carte" style="margin-top:18px;">
      <b>Conseil de sécurité :</b>
      <p class="souligne" style="margin:6px 0 0;">Notre équipe ne vous demandera jamais votre mot de passe ou vos codes secrets. Restez vigilant face au phishing.</p>
    </div>
  `;
  res.send(page("Support", contenu));
});

// ============================================================================
// 14) GÉNÉRATION DES PDF
// ============================================================================
async function genererFichePDF(t) {
  const bufferAlipay = t.alipayImage ? await bufferFichier(t.alipayImage, DOSSIER_UPLOADS_ALIPAY).catch(() => null) : null;
  const bufferPreuve = t.imagePaiement ? await bufferFichier(t.imagePaiement, DOSSIER_UPLOADS_PREUVES).catch(() => null) : null;

  return genererEtStockerPDF(
    `${t.reference}.pdf`,
    async (doc) => {
      doc.fontSize(18).fillColor("#2563EB").text(`Fiche interne — ${CONFIG.NOM_SITE}`);
      doc.moveDown(0.8);
      doc.fontSize(11).fillColor("#111");
      doc.text(`Référence : ${t.reference}`);
      doc.text(`Client : ${t.identifiantUtilisateur} — ${t.prenomNomComplet || t.nomUtilisateur}`);
      doc.text(`Montant RMB : ${t.montantRMB}`);
      doc.text(`Total XOF : ${formaterFCFA(t.total)} F CFA`);
      doc.text(`Moyen de paiement : ${CONFIG.PAIEMENT[t.moyenPaiement]?.nom || t.moyenPaiement}`);
      doc.text(`Statut : ${t.statut}`);

      // QR Alipay et preuve de paiement côte à côte, sur la même page.
      doc.moveDown(1);
      const yImages = doc.y;
      const largeurColonne = 240;
      const xGauche = 50;
      const xDroite = 595.28 - 50 - largeurColonne;
      const hauteurMax = 420;

      if (bufferAlipay) {
        doc.fontSize(11).fillColor("#2563EB").text("QR Alipay du client", xGauche, yImages, { width: largeurColonne, align: "center" });
        try { doc.image(bufferAlipay, xGauche, yImages + 16, { fit: [largeurColonne, hauteurMax], align: "center" }); } catch (e) {}
      }
      if (bufferPreuve) {
        doc.fontSize(11).fillColor("#2563EB").text("Preuve de paiement", xDroite, yImages, { width: largeurColonne, align: "center" });
        try { doc.image(bufferPreuve, xDroite, yImages + 16, { fit: [largeurColonne, hauteurMax], align: "center" }); } catch (e) {}
      }
    },
    "fiches",
    DOSSIER_FICHES
  );
}
async function genererRecuClient(t) {
  const bufferAlipay = t.alipayImage ? await bufferFichier(t.alipayImage, DOSSIER_UPLOADS_ALIPAY).catch(() => null) : null;
  const bufferPreuve = t.imagePaiement ? await bufferFichier(t.imagePaiement, DOSSIER_UPLOADS_PREUVES).catch(() => null) : null;

  return genererEtStockerPDF(
    `${t.reference}.pdf`,
    async (doc) => {
      doc.fontSize(20).fillColor("#2563EB").text(CONFIG.NOM_SITE, { align: "center" });
      doc.fontSize(12).fillColor("#555").text("Reçu de transaction", { align: "center" });
      doc.moveDown(1.5);
      doc.fontSize(11).fillColor("#111");
      doc.text(`Référence : ${t.reference}`);
      doc.text(`Client : ${t.prenomNomComplet || t.nomUtilisateur}`);
      doc.text(`Date : ${new Date(t.dateCredit || Date.now()).toLocaleString("fr-FR")}`);
      doc.text(`Montant reçu sur Alipay : ${t.montantRMB} RMB`);
      doc.text(`Montant payé : ${formaterFCFA(t.total)} F CFA`);
      doc.text(`Moyen de paiement : ${CONFIG.PAIEMENT[t.moyenPaiement]?.nom || t.moyenPaiement}`);
      doc.moveDown(1);
      doc.fontSize(13).fillColor("#22C55E").text("✔ Transaction effectuée avec succès", { align: "center" });

      // Les deux images côte à côte, sur la même page (pas de doc.addPage()).
      doc.moveDown(1);
      const yImages = doc.y;
      const largeurColonne = 220;
      const xGauche = 50;
      const xDroite = 595.28 - 50 - largeurColonne;
      const hauteurMax = 400;

      if (bufferAlipay) {
        doc.fontSize(10).fillColor("#2563EB").text("Code QR Alipay", xGauche, yImages, { width: largeurColonne, align: "center" });
        try {
          doc.image(bufferAlipay, xGauche, yImages + 16, { fit: [largeurColonne, hauteurMax], align: "center" });
        } catch (e) {}
      }
      if (bufferPreuve) {
        doc.fontSize(10).fillColor("#2563EB").text("Preuve de paiement", xDroite, yImages, { width: largeurColonne, align: "center" });
        try {
          doc.image(bufferPreuve, xDroite, yImages + 16, { fit: [largeurColonne, hauteurMax], align: "center" });
        } catch (e) {}
      }
    },
    "recus",
    DOSSIER_RECUS
  );
}

// ============================================================================
// 15) ESPACE ADMINISTRATEUR
// ============================================================================
app.get("/admin/connexion", (req, res) => {
  const contenu = `
    <h1>Connexion administrateur</h1>
    <div class="carte">
      <form method="POST" action="/admin/connexion">
        <label for="identifiant">Identifiant</label>
        <input type="text" id="identifiant" name="identifiant" required>
        <label for="motDePasse">Mot de passe</label>
        <input type="password" id="motDePasse" name="motDePasse" required>
        <button type="submit">Se connecter</button>
      </form>
    </div>
  `;
  res.send(page("Connexion admin", contenu, { admin: true }));
});
app.post("/admin/connexion", (req, res) => {
  const { identifiant, motDePasse } = req.body;
  if (identifiant !== CONFIG.ADMIN_IDENTIFIANT || motDePasse !== CONFIG.ADMIN_MOT_DE_PASSE) {
    return res.status(401).send(page("Erreur", `<h1>Identifiant ou mot de passe incorrect</h1><a href="/admin/connexion">← Réessayer</a>`, { admin: true }));
  }
  connecterAdmin(res);
  res.redirect("/admin");
});
app.get("/admin/deconnexion", (req, res) => {
  deconnecterAdmin(req, res);
  res.redirect("/admin/connexion");
});

app.get("/admin", exigerAdmin, (req, res) => {
  const enAttenteVerif = utilisateurs.filter((u) => u.statutVerification === "en_attente").length;
  const enAttenteConfirmation = transactions.filter((t) => t.statut === "preuve_recue").length;
  const enAttenteCredit = transactions.filter((t) => t.statut === "paye").length;
  const contenu = `
    <h1>Espace administrateur</h1>
    <div class="nav-admin">
      <a href="/admin/utilisateurs">Comptes à vérifier (${enAttenteVerif})</a>
      <a href="/admin/transactions">Transactions (${enAttenteConfirmation} à confirmer, ${enAttenteCredit} à créditer)</a>
      <a href="/admin/deconnexion">Déconnexion</a>
    </div>
    ${PUSH_ACTIF ? `
    <div class="carte">
      <h2>🔔 Notifications</h2>
      <p class="souligne" id="statutPush">Vérification en cours...</p>
      <button id="btnActiverPush" class="jaune" style="display:none;">Activer les notifications sur cet appareil</button>
    </div>
    <script>
      const VAPID_PUBLIC_KEY = "${process.env.VAPID_PUBLIC_KEY}";
      function urlBase64ToUint8Array(base64String) {
        const padding = '='.repeat((4 - base64String.length % 4) % 4);
        const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
        const rawData = window.atob(base64);
        return Uint8Array.from([...rawData].map(c => c.charCodeAt(0)));
      }
      async function initPush() {
        const statutEl = document.getElementById('statutPush');
        const btn = document.getElementById('btnActiverPush');
        if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
          statutEl.textContent = "Les notifications ne sont pas supportées par ce navigateur.";
          return;
        }
        const registration = await navigator.serviceWorker.ready;
        const abonnementExistant = await registration.pushManager.getSubscription();
        if (abonnementExistant) {
          statutEl.textContent = "✅ Notifications activées sur cet appareil.";
          return;
        }
        statutEl.textContent = "Recevez une alerte dès qu'un compte est à vérifier ou qu'une preuve de paiement arrive.";
        btn.style.display = 'block';
        btn.addEventListener('click', async () => {
          try {
            const permission = await Notification.requestPermission();
            if (permission !== 'granted') { statutEl.textContent = "Permission refusée."; return; }
            const abonnement = await registration.pushManager.subscribe({
              userVisibleOnly: true,
              applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
            });
            await fetch('/admin/notifications-push/abonner', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(abonnement),
            });
            statutEl.textContent = "✅ Notifications activées sur cet appareil.";
            btn.style.display = 'none';
          } catch (e) {
            statutEl.textContent = "Erreur : " + e.message;
          }
        });
      }
      initPush();
    </script>
    ` : ""}
  `;
  res.send(page("Admin", contenu, { large: true, admin: true }));
});

app.post("/admin/notifications-push/abonner", exigerAdmin, (req, res) => {
  const abonnement = req.body;
  if (!abonnement || !abonnement.endpoint) return res.status(400).json({ ok: false });
  const dejaPresent = abonnementsPush.some((a) => a.endpoint === abonnement.endpoint);
  if (!dejaPresent) {
    abonnementsPush.push(abonnement);
    sauvegarderJSON(FICHIER_ABONNEMENTS_PUSH, abonnementsPush);
  }
  res.json({ ok: true });
});

app.get("/admin/utilisateurs", exigerAdmin, (req, res) => {
  const lignes = [...utilisateurs].reverse().map((u) => {
    const estPdf = u.pieceIdentiteEstPdf ?? (u.pieceIdentite && u.pieceIdentite.toLowerCase().endsWith(".pdf"));
    const lienPiece = hrefFichier(u.pieceIdentite, "uploads/identite");
    const image = !u.pieceIdentite ? "—" : estPdf
      ? `<a href="${lienPiece}" target="_blank">📄 PDF</a>`
      : `<a href="${lienPiece}" target="_blank"><img class="miniature" src="${lienPiece}"></a>`;
    const infos = u.nom
      ? `${u.prenom} ${u.nom}<br><small style="color:var(--texte-att);">${u.telephone}</small>`
      : `<em>${u.pseudo} (profil incomplet)</em>`;
    const actions = u.compteSupprime
      ? `<form style="display:inline" method="POST" action="/admin/utilisateurs/${u.id}/reactiver"><button class="mini-bouton ok">Réactiver</button></form>
         <a class="mini-bouton refus" style="text-decoration:none; display:inline-block;" href="/admin/utilisateurs/${u.id}/supprimer-definitivement">Supprimer définitivement</a>`
      : u.statutVerification === "en_attente"
      ? `<form style="display:inline" method="POST" action="/admin/utilisateurs/${u.id}/verifier"><button class="mini-bouton ok">Vérifier</button></form>
         <form style="display:inline" method="POST" action="/admin/utilisateurs/${u.id}/refuser"><button class="mini-bouton refus">Refuser</button></form>`
      : "";
    const badgeStatut = u.compteSupprime
      ? `<span class="badge badge-refuse">Compte supprimé</span>`
      : `<span class="badge badge-${u.statutVerification === "verifie" ? "verifie" : u.statutVerification === "refuse" ? "refuse" : "attente"}">${u.statutVerification.replace(/_/g, " ")}</span>`;
    return `<tr${u.compteSupprime ? ' style="opacity:0.55;"' : ""}><td>${image}</td><td>${u.identifiant}</td><td>${infos}</td><td>${badgeStatut}</td><td>${actions}</td></tr>`;
  }).join("");

  const contenu = `
    <div class="nav-admin"><a href="/admin">← Accueil admin</a><a href="/admin/transactions">Transactions</a></div>
    <h1>Comptes clients</h1>
    <p class="souligne">Les comptes supprimés par leurs propriétaires restent visibles ici (accès révoqué mais données archivées).</p>
    ${utilisateurs.length === 0 ? `<p class="aucune-donnee">Aucun compte.</p>` : `<table class="admin"><thead><tr><th>Pièce</th><th>E-mail</th><th>Infos</th><th>Statut</th><th>Action</th></tr></thead><tbody>${lignes}</tbody></table>`}
  `;
  res.send(page("Comptes clients", contenu, { large: true, admin: true }));
});
app.post("/admin/utilisateurs/:id/verifier", exigerAdmin, (req, res) => {
  const u = utilisateurs.find((x) => x.id === req.params.id);
  if (u) {
    u.statutVerification = "verifie";
    sauvegarderJSON(FICHIER_UTILISATEURS, utilisateurs);
    envoyerEmail(
      u.identifiant,
      `${CONFIG.NOM_SITE} — votre compte est vérifié ✔`,
      `<p>Bonjour ${u.prenom || u.pseudo},</p><p>Bonne nouvelle : votre profil et votre pièce d'identité ont été vérifiés avec succès.</p><p>Vous pouvez dès à présent effectuer vos transactions de recharge Alipay sur ${CONFIG.NOM_SITE}.</p>`
    ).catch((err) => console.error("Erreur e-mail vérification compte :", err.message));
  }
  res.redirect("/admin/utilisateurs");
});
app.post("/admin/utilisateurs/:id/refuser", exigerAdmin, (req, res) => {
  const u = utilisateurs.find((x) => x.id === req.params.id);
  if (u) { u.statutVerification = "refuse"; u.raisonRefus = MESSAGE_REFUS_IDENTITE; sauvegarderJSON(FICHIER_UTILISATEURS, utilisateurs); }
  res.redirect("/admin/utilisateurs");
});
// Réactivation manuelle d'un compte archivé, après contact du client avec le support.
app.post("/admin/utilisateurs/:id/reactiver", exigerAdmin, (req, res) => {
  const u = utilisateurs.find((x) => x.id === req.params.id);
  if (u) {
    u.compteSupprime = false;
    u.dateSuppressionCompte = null;
    u.dateReactivationCompte = new Date().toISOString();
    sauvegarderJSON(FICHIER_UTILISATEURS, utilisateurs);
    envoyerEmail(
      u.identifiant,
      `${CONFIG.NOM_SITE} — votre compte a été réactivé ✔`,
      `<p>Bonjour ${u.prenom || u.pseudo},</p><p>Bonne nouvelle : votre compte ${CONFIG.NOM_SITE} a été réactivé par notre équipe.</p><p>Vous pouvez dès à présent vous reconnecter avec votre e-mail et votre mot de passe habituels, et retrouver l'ensemble de votre historique.</p>`
    ).catch((err) => console.error("Erreur e-mail réactivation :", err.message));
  }
  res.redirect("/admin/utilisateurs");
});

// Suppression DÉFINITIVE (compte + transactions + notifications), réservée
// aux comptes déjà archivés par précaution. Action irréversible.
app.get("/admin/utilisateurs/:id/supprimer-definitivement", exigerAdmin, (req, res) => {
  const u = utilisateurs.find((x) => x.id === req.params.id);
  if (!u) return res.redirect("/admin/utilisateurs");
  const nbTransactions = transactions.filter((t) => t.utilisateurId === u.id).length;
  const nbNotifications = notifications.filter((n) => n.utilisateurId === u.id).length;
  const contenu = `
    <h1>Supprimer définitivement ce compte</h1>
    <div class="banniere banniere-erreur">
      Cette action est <b>définitive et irréversible</b>. Le compte ${u.identifiant}, ainsi que ${nbTransactions} transaction(s) et ${nbNotifications} notification(s) associées, seront effacés de la base de données pour toujours.
    </div>
    <form method="POST" action="/admin/utilisateurs/${u.id}/supprimer-definitivement">
      <button type="submit" class="danger">Oui, tout supprimer définitivement</button>
    </form>
    <a class="lien-discret" href="/admin/utilisateurs">← Annuler</a>
  `;
  res.send(page("Suppression définitive", contenu, { large: true, admin: true }));
});
app.post("/admin/utilisateurs/:id/supprimer-definitivement", exigerAdmin, (req, res) => {
  const idCible = req.params.id;
  utilisateurs = utilisateurs.filter((u) => u.id !== idCible);
  transactions = transactions.filter((t) => t.utilisateurId !== idCible);
  notifications = notifications.filter((n) => n.utilisateurId !== idCible);
  sauvegarderJSON(FICHIER_UTILISATEURS, utilisateurs);
  sauvegarderJSON(FICHIER_TRANSACTIONS, transactions);
  sauvegarderJSON(FICHIER_NOTIFICATIONS, notifications);
  res.redirect("/admin/utilisateurs");
});

app.get("/admin/transactions", exigerAdmin, (req, res) => {
  const filtreStatut = req.query.statut || "tout";
  const recherche = (req.query.q || "").trim().toLowerCase();

  let listeFiltree = [...transactions];
  if (filtreStatut !== "tout") listeFiltree = listeFiltree.filter((t) => t.statut === filtreStatut);
  if (recherche) {
    listeFiltree = listeFiltree.filter(
      (t) => t.reference.toLowerCase().includes(recherche) || (t.identifiantUtilisateur || "").toLowerCase().includes(recherche)
    );
  }

  const lignes = listeFiltree.reverse().map((t) => {
    const lienAlipay = hrefFichier(t.alipayImage, "uploads/alipay");
    const imgAlipay = t.alipayImage ? `<a href="${lienAlipay}" target="_blank"><img class="miniature" src="${lienAlipay}"></a>` : "—";
    const estPdf = t.imagePaiementEstPdf ?? (t.imagePaiement && t.imagePaiement.toLowerCase().endsWith(".pdf"));
    const lienPreuve = hrefFichier(t.imagePaiement, "uploads/preuves");
    const imgPreuve = !t.imagePaiement ? "—" : estPdf ? `<a href="${lienPreuve}" target="_blank">📄 PDF</a>` : `<a href="${lienPreuve}" target="_blank"><img class="miniature" src="${lienPreuve}"></a>`;
    const heurePreuve = t.datePreuve ? new Date(t.datePreuve).toLocaleString("fr-FR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "—";
    const fiche = `${t.fichePDF ? `<a href="${hrefFichier(t.fichePDF, "fiches")}" target="_blank">📄</a>` : "—"} <form style="display:inline" method="POST" action="/admin/transactions/${t.reference}/regenerer-fiche"><button class="mini-bouton info" style="padding:2px 6px; font-size:11px;" title="Régénérer la fiche">↻</button></form>`;
    let actions = "";
    if (t.statut === "preuve_recue") {
      actions = `<form style="display:inline" method="POST" action="/admin/transactions/${t.reference}/confirmer-paiement"><button class="mini-bouton info">Confirmer</button></form>
                 <form style="display:inline" method="POST" action="/admin/transactions/${t.reference}/annuler-paiement"><button class="mini-bouton refus">Annuler</button></form>`;
    } else if (t.statut === "paye") {
      actions = `<form method="POST" action="/admin/transactions/${t.reference}/confirmer-recharge"><button class="mini-bouton ok">Confirmer recharge Alipay</button></form>`;
    } else if (t.statut === "annule") {
      actions = `<span style="font-size:12px; color:var(--texte-att);">${t.raisonAnnulation || "—"}</span>`;
    }
    return `<tr><td>${imgAlipay}</td><td>${t.reference}</td><td>${t.identifiantUtilisateur}</td><td>${t.total.toLocaleString("fr-FR")} XOF</td><td>${t.montantRMB} RMB</td><td>${t.numeroExpediteur || "—"}</td><td>${imgPreuve}</td><td>${heurePreuve}</td><td>${CONFIG.PAIEMENT[t.moyenPaiement]?.nom || "—"}</td><td>${t.statut}</td><td>${fiche}</td><td>${actions}</td></tr>`;
  }).join("");

  const filtreLien = (cle, texte) => `<a href="/admin/transactions?statut=${cle}" style="${filtreStatut === cle ? "background:var(--bleu); color:#fff;" : ""}">${texte}</a>`;

  const contenu = `
    <div class="nav-admin"><a href="/admin">← Accueil admin</a><a href="/admin/utilisateurs">Comptes clients</a></div>
    <h1>Transactions</h1>
    <form method="GET" action="/admin/transactions" style="margin-bottom:14px; display:flex; gap:8px;">
      <input type="text" name="q" value="${recherche}" placeholder="Rechercher par référence ou e-mail" style="max-width:320px;">
      <button type="submit" class="petit fantome" style="margin-top:0;">Rechercher</button>
    </form>
    <div class="nav-admin">
      ${filtreLien("tout", "Tout")}
      ${filtreLien("preuve_recue", "À confirmer")}
      ${filtreLien("paye", "À créditer")}
      ${filtreLien("effectue", "Terminées")}
      ${filtreLien("annule", "Annulées")}
    </div>
    ${listeFiltree.length === 0 ? `<p class="aucune-donnee">Aucune transaction.</p>` : `<table class="admin"><thead><tr><th>QR Alipay</th><th>Réf</th><th>Client</th><th>Total</th><th>RMB</th><th>N° dépôt</th><th>Preuve</th><th>Heure</th><th>Moyen</th><th>Statut</th><th>Fiche</th><th>Action</th></tr></thead><tbody>${lignes}</tbody></table>`}
    <p class="souligne" style="margin-top:16px;">Export : <a href="/admin/transactions.json">/admin/transactions.json</a></p>
  `;
  res.send(page("Transactions", contenu, { large: true, admin: true }));
});
app.get("/admin/transactions.json", exigerAdmin, (req, res) => res.json(transactions));

app.post("/admin/transactions/:reference/regenerer-fiche", exigerAdmin, async (req, res) => {
  const t = transactions.find((x) => x.reference === req.params.reference);
  if (!t) return res.redirect("/admin/transactions");
  try {
    const { reference } = await genererFichePDF(t);
    t.fichePDF = reference;
    sauvegarderJSON(FICHIER_TRANSACTIONS, transactions);
    res.redirect("/admin/transactions");
  } catch (erreur) {
    console.error("Erreur régénération fiche :", erreur.message);
    res.status(500).send(page("Erreur", `<h1>Échec de la régénération</h1><p class="souligne">${erreur.message}</p><a href="/admin/transactions">← Retour</a>`, { admin: true }));
  }
});
app.post("/admin/transactions/:reference/regenerer-recu", exigerAdmin, async (req, res) => {
  const t = transactions.find((x) => x.reference === req.params.reference);
  if (!t) return res.redirect("/admin/transactions");
  try {
    const { reference } = await genererRecuClient(t);
    t.recuPDF = reference;
    sauvegarderJSON(FICHIER_TRANSACTIONS, transactions);
    res.redirect("/admin/transactions");
  } catch (erreur) {
    console.error("Erreur régénération reçu :", erreur.message);
    res.status(500).send(page("Erreur", `<h1>Échec de la régénération</h1><p class="souligne">${erreur.message}</p><a href="/admin/transactions">← Retour</a>`, { admin: true }));
  }
});

app.post("/admin/transactions/:reference/confirmer-paiement", exigerAdmin, async (req, res) => {
  const t = transactions.find((x) => x.reference === req.params.reference);
  if (t && t.statut === "preuve_recue") {
    t.statut = "paye";
    t.datePaiementConfirme = new Date().toISOString();
    try {
      const { reference } = await genererFichePDF(t);
      t.fichePDF = reference;
    } catch (e) {}
    sauvegarderJSON(FICHIER_TRANSACTIONS, transactions);
    ajouterNotification(t.utilisateurId, `Votre paiement de ${t.total.toLocaleString("fr-FR")} F CFA a été confirmé. Créditation Alipay en cours.`, t.reference);
  }
  res.redirect("/admin/transactions");
});
app.post("/admin/transactions/:reference/annuler-paiement", exigerAdmin, (req, res) => {
  const t = transactions.find((x) => x.reference === req.params.reference);
  if (t && t.statut === "preuve_recue") {
    t.statut = "annule";
    t.raisonAnnulation = MESSAGE_PAIEMENT_ANNULE;
    t.dateAnnulation = new Date().toISOString();
    sauvegarderJSON(FICHIER_TRANSACTIONS, transactions);
    ajouterNotification(t.utilisateurId, `Votre paiement pour la référence ${t.reference} a été annulé. Contactez le support pour plus d'informations.`, t.reference);
  }
  res.redirect("/admin/transactions");
});
app.post("/admin/transactions/:reference/confirmer-recharge", exigerAdmin, async (req, res) => {
  const t = transactions.find((x) => x.reference === req.params.reference);
  if (t && t.statut === "paye") {
    t.statut = "effectue";
    t.dateCredit = new Date().toISOString();
    try {
      const { reference: refFiche } = await genererFichePDF(t);
      t.fichePDF = refFiche;
    } catch (e) { console.error("Erreur génération fiche interne :", e.message); }
    try {
      const { reference: refRecu } = await genererRecuClient(t);
      t.recuPDF = refRecu;
    } catch (e) { console.error("Erreur génération reçu client :", e.message); }
    sauvegarderJSON(FICHIER_TRANSACTIONS, transactions);
    ajouterNotification(t.utilisateurId, `Votre compte Alipay a été crédité de ${t.montantRMB} RMB ✔ Transaction terminée.`, t.reference);
  }
  // ➕ AJOUT : E-mail de confirmation de recharge Alipay terminée
    envoyerEmailTransaction(
      t.identifiantUtilisateur,
      `Recharge effectuée — Commande ${t.reference}`,
      `Votre compte Alipay a été crédité de <b>${t.montantRMB} RMB</b> avec succès ! Votre reçu est désormais disponible sur votre espace client.`
    ).catch((err) => console.error("Erreur e-mail recharge :", err.message));
  res.redirect("/admin/transactions");
});

// ============================================================================
// 16) GESTION DES ERREURS D'UPLOAD (multer)
// ============================================================================
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError || (err && err.message && err.message.includes("non autorisé"))) {
    return res.status(400).send(page("Erreur", `<h1>Fichier invalide</h1><p class="souligne">${err.message}</p><a href="javascript:history.back()">← Retour</a>`));
  }
  console.error(err);
  res.status(500).send("Erreur serveur");
});

// ============================================================================
// 16bis) NETTOYAGE AUTOMATIQUE : notifications anciennes + archivage des
// fichiers de transactions de plus de 6 mois (envoyés par e-mail en zip,
// puis supprimés de Cloudinary pour libérer de l'espace).
// ============================================================================

// Extrait { resourceType, publicId } d'une URL Cloudinary, pour pouvoir la supprimer.
function extraireInfosCloudinary(url) {
  if (!url || !url.startsWith("http")) return null;
  const m = url.match(/\/([a-z]+)\/upload\/v\d+\/(.+)\.[a-zA-Z0-9]+(?:\?.*)?$/);
  if (!m) return null;
  return { resourceType: m[1], publicId: m[2] };
}
async function supprimerFichierCloudinary(url) {
  const infos = extraireInfosCloudinary(url);
  if (!infos) return;
  try {
    await cloudinary.uploader.destroy(infos.publicId, { resource_type: infos.resourceType });
  } catch (erreur) {
    console.error("Erreur suppression Cloudinary :", erreur.message);
  }
}
function extensionDepuisURL(url, parDefaut) {
  if (!url) return parDefaut;
  const ext = url.split("?")[0].split(".").pop();
  return ext && ext.length <= 5 ? ext : parDefaut;
}

// Envoi d'un e-mail avec pièce jointe via Brevo (le reste du fichier utilise
// envoyerEmail(), sans pièce jointe, pour les autres notifications).
async function envoyerEmailAvecPieceJointe(destinataire, sujet, contenuHTML, nomFichier, buffer) {
  try {
    await axios.post(
      "https://api.brevo.com/v3/smtp/email",
      {
        sender: { name: process.env.SENDER_NAME || CONFIG.NOM_SITE, email: process.env.SENDER_EMAIL },
        to: [{ email: destinataire }],
        subject: sujet,
        htmlContent: contenuHTML,
        attachment: [{ content: buffer.toString("base64"), name: nomFichier }],
      },
      { headers: { accept: "application/json", "api-key": process.env.BREVO_API_KEY, "content-type": "application/json" } }
    );
    return true;
  } catch (erreur) {
    console.error("Erreur envoi e-mail avec pièce jointe :", erreur.response ? erreur.response.data : erreur.message);
    return false;
  }
}

const JOUR_MS = 24 * 3600 * 1000;

async function nettoyageAutomatiqueQuotidien() {
  try {
    // 1. Suppression des notifications de plus de 3 mois (90 jours).
    const seuilNotifs = Date.now() - 90 * JOUR_MS;
    const avant = notifications.length;
    notifications = notifications.filter((n) => new Date(n.date).getTime() >= seuilNotifs);
    if (notifications.length !== avant) {
      sauvegarderJSON(FICHIER_NOTIFICATIONS, notifications);
      console.log(`🗑️  ${avant - notifications.length} notification(s) de plus de 3 mois supprimée(s).`);
    }

    // 2. Archivage des fichiers de transactions de plus de 6 mois (180 jours).
    // Uniquement possible en mode Cloudinary (rien à libérer en mode local).
    if (!CLOUDINARY_ACTIF) return;
    const seuilFichiers = Date.now() - 180 * JOUR_MS;
    const aArchiver = transactions.filter(
      (t) =>
        !t.archiveEnvoyee &&
        new Date(t.dateCreation).getTime() < seuilFichiers &&
        (t.alipayImage || t.imagePaiement || t.fichePDF || t.recuPDF)
    );
    if (aArchiver.length === 0) return;

    const archive = archiver("zip", { zlib: { level: 9 } });
    const morceaux = [];
    archive.on("data", (m) => morceaux.push(m));
    const finPromesse = new Promise((resolve, reject) => {
      archive.on("end", resolve);
      archive.on("error", reject);
    });

    const champsAArchiver = [
      ["alipayImage", "qr-alipay", "jpg"],
      ["imagePaiement", "preuve-paiement", "jpg"],
      ["fichePDF", "fiche-interne", "pdf"],
      ["recuPDF", "recu-client", "pdf"],
    ];
    for (const t of aArchiver) {
      for (const [champ, nom, extDefaut] of champsAArchiver) {
        const ref = t[champ];
        if (!ref) continue;
        try {
          const buffer = await bufferFichier(ref, DOSSIER_UPLOADS_PREUVES);
          const extension = extensionDepuisURL(ref, extDefaut);
          archive.append(buffer, { name: `${t.reference}/${nom}.${extension}` });
        } catch (erreur) {
          console.error(`Erreur récupération fichier ${champ} (${t.reference}) :`, erreur.message);
        }
      }
    }
    archive.finalize();
    await finPromesse;
    const bufferZip = Buffer.concat(morceaux);

    const nomZip = `archive-${CONFIG.NOM_SITE.toLowerCase()}-${new Date().toISOString().slice(0, 10)}.zip`;
    const envoye = await envoyerEmailAvecPieceJointe(
      CONFIG.CONTACT_EMAIL,
      `Archive automatique — ${aArchiver.length} transaction(s) de plus de 6 mois`,
      `<p>Bonjour,</p><p>Voici l'archive des fichiers de <b>${aArchiver.length}</b> transaction(s) de plus de 6 mois, avant leur suppression de Cloudinary pour libérer de l'espace.</p><p>Références concernées : ${aArchiver.map((t) => t.reference).join(", ")}</p>`,
      nomZip,
      bufferZip
    );

    if (!envoye) {
      console.error("⚠️  Archive non envoyée par e-mail : les fichiers ne seront PAS supprimés cette fois (nouvelle tentative demain).");
      return;
    }

    // Suppression des fichiers Cloudinary + marquage comme archivé, seulement
    // après confirmation que l'e-mail est bien parti.
    for (const t of aArchiver) {
      for (const [champ] of champsAArchiver) {
        if (t[champ]) await supprimerFichierCloudinary(t[champ]);
      }
      t.archiveEnvoyee = true;
      t.dateArchivage = new Date().toISOString();
    }
    sauvegarderJSON(FICHIER_TRANSACTIONS, transactions);
    console.log(`📦 Archive envoyée par e-mail et fichiers Cloudinary libérés pour ${aArchiver.length} transaction(s).`);
  } catch (erreur) {
    console.error("Erreur pendant le nettoyage automatique quotidien :", erreur.message);
  }
}

// ============================================================================
// 17) DÉMARRAGE
// ============================================================================
async function demarrerServeur() {
  // 1. Connexion à MongoDB (si configurée) AVANT toute autre chose.
  await connecterMongo();

  // 2. Chargement des données (depuis MongoDB, ou depuis les fichiers JSON
  // locaux en secours) dans les tableaux utilisés partout dans le fichier.
  utilisateurs = await chargerJSON(FICHIER_UTILISATEURS);
  transactions = await chargerJSON(FICHIER_TRANSACTIONS);
  notifications = await chargerJSON(FICHIER_NOTIFICATIONS);
  abonnementsPush = await chargerJSON(FICHIER_ABONNEMENTS_PUSH);

  // 3. Démarrage du serveur HTTP une fois les données prêtes.
  app.listen(CONFIG.PORT, () => {
    console.log(`✅ ${CONFIG.NOM_SITE} lancé sur http://localhost:${CONFIG.PORT}`);
    if (!process.env.ADMIN_MOT_DE_PASSE || CONFIG.ADMIN_MOT_DE_PASSE === "ChangezMoi123!") {
      console.warn("⚠️  ATTENTION : mot de passe admin par défaut détecté. Définissez ADMIN_IDENTIFIANT et ADMIN_MOT_DE_PASSE dans votre fichier .env avant de mettre le site en ligne.");
    } else {
      console.log(`   Admin : http://localhost:${CONFIG.PORT}/admin/connexion (identifiant/mot de passe définis dans .env)`);
    }
  });

  // 4. Nettoyage automatique quotidien (notifications > 3 mois supprimées,
  // fichiers de transactions > 6 mois archivés par e-mail puis libérés de
  // Cloudinary). Premier passage 2 minutes après le démarrage, puis toutes
  // les 24h.
  setTimeout(() => nettoyageAutomatiqueQuotidien(), 2 * 60 * 1000);
  setInterval(() => nettoyageAutomatiqueQuotidien(), JOUR_MS);
}
demarrerServeur();
// Fonction d'envoi d'e-mail unique et réutilisable (utilisée par
// envoyerEmailBienvenue, envoyerEmailReinitialisation et envoyerEmailTransaction).
async function envoyerEmail(destinataire, sujet, contenu, titre = sujet, bouton = null) {
  // 1. Préparation du bouton HTML
  const boutonHtml = bouton ? `
    <table border="0" cellspacing="0" cellpadding="0" align="center" style="margin: 30px auto;">
      <tr>
        <td align="center" style="border-radius: 5px; background-color: #3bb54a;">
          <a href="${bouton.lien}" target="_blank" style="font-size: 15px; font-family: Arial, sans-serif; color: #ffffff; text-decoration: none; padding: 13px 25px; border-radius: 5px; display: inline-block; font-weight: bold;">
            ${bouton.texte}
          </a>
        </td>
      </tr>
    </table>
  ` : '';

  // 2. Préparation du template complet
  const htmlComplet = `
  <!DOCTYPE html>
  <html lang="fr">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
  </head>
  <body style="margin: 0; padding: 0; background-color: #f4f6f8; font-family: Arial, Helvetica, sans-serif; color: #333333;">
    <table align="center" border="0" cellpadding="0" cellspacing="0" width="100%" style="max-width: 600px; margin: 30px auto; background-color: #ffffff; border-radius: 6px; overflow: hidden; box-shadow: 0 2px 8px rgba(0,0,0,0.08);">
      
      <!-- BANDEAU BLEU -->
      <tr>
        <td style="background-color: #2b5b9a; padding: 18px 25px;">
          <table width="100%" border="0" cellspacing="0" cellpadding="0">
            <tr>
              <td align="left" style="color: #ffffff; font-size: 22px; font-weight: bold; letter-spacing: 0.5px;">
                ALIPAFRIC
              </td>
              <td align="right" style="color: #ffffff; font-size: 13px;">
                Notification
              </td>
            </tr>
          </table>
        </td>
      </tr>

      <!-- CONTENU -->
      <tr>
        <td style="padding: 35px 30px;">
          <h2 style="color: #222222; font-size: 20px; font-weight: normal; margin-top: 0; margin-bottom: 20px; line-height: 1.4;">
            ${titre}
          </h2>
          
          <div style="font-size: 14px; line-height: 1.6; color: #444444; margin-bottom: 25px;">
            ${contenu}
          </div>

          ${boutonHtml}

          <p style="font-size: 13px; line-height: 1.5; color: #666666; margin-top: 30px; margin-bottom: 0;">
            Si vous n'êtes pas à l'origine de cette demande, vous pouvez ignorer cet e-mail en toute sécurité.
          </p>
        </td>
      </tr>

      <!-- PIED DE PAGE -->
      <tr>
        <td style="background-color: #f8f9fa; padding: 15px 30px; text-align: center; border-top: 1px solid #eeeeee; font-size: 12px; color: #888888;">
          © ALIPAFRIC - Plateforme sécurisée de recharge
        </td>
      </tr>

    </table>
  </body>
  </html>
  `;

  // 3. Envoi de l'e-mail via Brevo
  try {
    const response = await axios.post(
      'https://api.brevo.com/v3/smtp/email',
      {
        sender: { 
          name: process.env.SENDER_NAME || "ALIPAFRIC", 
          email: process.env.SENDER_EMAIL 
        },
        to: [{ email: destinataire }],
        subject: sujet,
        htmlContent: htmlComplet
      },
      {
        headers: {
          'api-key': process.env.BREVO_API_KEY,
          'Content-Type': 'application/json'
        }
      }
    );

    console.log(`✉️ Email envoyé avec succès à : ${destinataire}`);
    return response.data;
      } catch (error) {
    console.error("❌ Erreur lors de l'envoi de l'e-mail :", error.response?.data || error.message);
  }
  };