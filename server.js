// ============================================================================
//  ALIPAFRIC — Recharge Alipay depuis le Togo (F CFA -> RMB)
//  ----------------------------------------------------------------------
//  Design inspiré d'une maquette fournie : thème sombre, accents bleu/jaune.
//  Toujours ultra léger : Express + fichiers JSON locaux + PDFKit.
// ============================================================================

const express = require("express");
const fs = require("fs");
const path = require('path');

// Indique à Express de servir le dossier "public"
app.use(express.static(path.join(__dirname, 'public')));
const crypto = require("crypto");
const multer = require("multer");
const PDFDocument = require("pdfkit");

const app = express();

// ----------------------------------------------------------------------------
// 1) CONFIGURATION
// ----------------------------------------------------------------------------
const CONFIG = {
  NOM_SITE: "AlipAfric",
  TAGLINE: "RECHARGE. SIMPLIFIÉ.",
  TAUX_CHANGE: 95, // 1 RMB = 95 F CFA
  MONTANT_MIN_RMB: 100,
  FRAIS_POURCENT: 0.5, // 0.5% de frais de service
  PORT: process.env.PORT || 3000,

  // ⚠️ Changez ces identifiants avant de mettre le site en ligne.
  ADMIN_IDENTIFIANT: "admin",
  ADMIN_MOT_DE_PASSE: "ChangezMoi123!",

  CONTACT_EMAIL: "support@alipafric.com",
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

function chargerJSON(cheminFichier) {
  try {
    return JSON.parse(fs.readFileSync(cheminFichier, "utf-8"));
  } catch (erreur) {
    return [];
  }
}
function sauvegarderJSON(cheminFichier, donnees) {
  fs.writeFileSync(cheminFichier, JSON.stringify(donnees, null, 2), "utf-8");
}

let utilisateurs = chargerJSON(FICHIER_UTILISATEURS);
let transactions = chargerJSON(FICHIER_TRANSACTIONS);
let notifications = chargerJSON(FICHIER_NOTIFICATIONS);

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
  const stockage = multer.diskStorage({
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
const uploadAlipay = creerUpload(DOSSIER_UPLOADS_ALIPAY, ["image/jpeg", "image/png", "image/jpg"], 5 * 1024 * 1024);
const uploadIdentite = creerUpload(
  DOSSIER_UPLOADS_IDENTITE,
  ["image/jpeg", "image/png", "image/jpg", "application/pdf"],
  2 * 1024 * 1024
);
const uploadPreuve = creerUpload(
  DOSSIER_UPLOADS_PREUVES,
  ["image/jpeg", "image/png", "image/jpg", "application/pdf"],
  8 * 1024 * 1024
);

// ----------------------------------------------------------------------------
// 5) MISE EN PAGE COMMUNE — thème sombre, accents bleu / jaune
// ----------------------------------------------------------------------------
function page(titre, contenuHTML, options = {}) {
  const classeCarte = options.large ? "conteneur conteneur-large" : "conteneur";
  return `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${titre} — ${CONFIG.NOM_SITE}</title>
<link rel="icon" type="image/png" href="/favicon.png">
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
      <h1>Rechargez votre <span>Alipay</span> depuis le Togo, en toute confiance</h1>
      <p>Envoyez vos F CFA, nous rechargeons votre compte Alipay en RMB. Rapide, suivi de bout en bout, et vérifié.</p>
      <div class="cta-rangee">
        <a class="bouton jaune" href="/inscription#formulaire">Commencer maintenant</a>
        <a class="bouton fantome" href="/connexion#formulaire">Se connecter</a>
      </div>
    </section>

    <div class="taux-boite">
      <span>Taux de change</span>
      <b>1 RMB = ${CONFIG.TAUX_CHANGE} F CFA</b>
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
      <p><b>Transparence des Prix :</b> Les tarifs applicables, exprimés en Francs CFA (XOF), incluent le coût de la conversion en Yuans (CNY), ainsi que les frais de service et d'intermédiation du Prestataire.</p>
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
      <p>En cas de contestation ou de litige, le Client s'engage à contacter en priorité le service client du Prestataire afin de rechercher une solution à l'amiable. À défaut de résolution amiable dans un délai de trente (30) jours, le litige sera porté devant les tribunaux compétents de Lomé (Togo).</p>
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
  if (utilisateurs.some((u) => u.identifiant.toLowerCase() === email.toLowerCase())) {
    return res.status(400).send(pageInscription({ email, cguCochee: true, erreurGlobal: "Ce compte existe déjà. Essayez de vous connecter plutôt." }));
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
    telephoneVerifie: false,
    pieceIdentite: null,
    statutVerification: "profil_incomplet",
    raisonRefus: null,
    dateInscription: new Date().toISOString(),
    cguAccepteesLe: new Date().toISOString(),
  };
  utilisateurs.push(utilisateur);
  sauvegarderJSON(FICHIER_UTILISATEURS, utilisateurs);
  connecterUtilisateur(res, utilisateur.id);
  res.redirect("/confirmer-email");
});

app.get("/confirmer-email", exigerConnexion, (req, res) => {
  const u = req.utilisateur;
  if (u.emailVerifie) return res.redirect("/compte");
  const contenu = `
    <h1>Confirmez votre e-mail</h1>
    <p class="souligne">Un code a été "envoyé" à ${u.identifiant}.</p>
    <div class="banniere banniere-attente">Code de démonstration (pas de service e-mail réel connecté) : <b style="font-size:18px;">${u.codeEmail}</b></div>
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
  res.redirect("/compte");
});
app.get("/confirmer-email/renvoyer", exigerConnexion, (req, res) => {
  req.utilisateur.codeEmail = genererCode();
  sauvegarderJSON(FICHIER_UTILISATEURS, utilisateurs);
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
app.post("/mot-de-passe-oublie", (req, res) => {
  const email = (req.body.email || "").trim();
  const u = utilisateurs.find((x) => x.identifiant.toLowerCase() === email.toLowerCase());
  // Message identique que le compte existe ou non, pour ne pas révéler quels e-mails sont inscrits.
  if (!u) {
    return res.send(pageMotDePasseOublie({ erreurGlobal: "Si un compte existe avec cet e-mail, un code de réinitialisation a été envoyé." }));
  }
  u.codeReinitialisation = genererCode();
  u.codeReinitialisationExpire = Date.now() + 15 * 60 * 1000; // valable 15 minutes
  sauvegarderJSON(FICHIER_UTILISATEURS, utilisateurs);
  res.redirect(`/reinitialiser-mot-de-passe?email=${encodeURIComponent(u.identifiant)}`);
});

function pageReinitialiserMotDePasse({ email = "", code = "", erreurGlobal = null, erreurMdp = null, codeDemo = null } = {}) {
  const contenu = `
    <h1>Réinitialiser le mot de passe</h1>
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
  res.send(pageReinitialiserMotDePasse({ email, codeDemo: u ? u.codeReinitialisation : null }));
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

  const mesTransactions = transactions.filter((t) => t.utilisateurId === u.id).slice(-3).reverse();
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
      <span>Taux de change</span>
      <b>1 RMB = ${CONFIG.TAUX_CHANGE} F CFA</b>
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
    const badgeTel = u.telephoneVerifie
      ? `<span class="badge badge-verifie">Téléphone vérifié</span>`
      : `<span class="badge badge-attente">Téléphone non vérifié</span>`;
    blocIdentite = `
      <div class="carte">
        <h2>Informations personnelles <span class="badge ${badgeClasse}">${badgeTexte}</span></h2>
        <div class="ligne"><span>Prénom</span><b>${u.prenom}</b></div>
        <div class="ligne"><span>Nom</span><b>${u.nom}</b></div>
        <div class="ligne"><span>Téléphone</span><b>${u.telephone} ${badgeTel}</b></div>
        <div class="ligne"><span>Pièce d'identité</span><b>${u.statutVerification === "verifie" ? "Vérifiée" : "Envoyée"}</b></div>
      </div>`;
  }

  const contenu = `
    ${entete("profil", u)}
    <h1>Mon profil</h1>
    ${blocIdentite}
    <div class="carte">
      <h2>Adresse e-mail</h2>
      <div class="ligne"><span>E-mail actuel</span><b>${u.identifiant}</b></div>
      <form method="POST" action="/compte/profil/changer-email">
        <label for="nouvelEmail">Nouvel e-mail</label>
        <input type="email" id="nouvelEmail" name="nouvelEmail" required>
        <button type="submit" class="fantome">Changer mon e-mail</button>
      </form>
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

app.post("/compte/profil", exigerConnexion, exigerEmailVerifie, uploadIdentite.single("pieceIdentite"), (req, res) => {
  const u = req.utilisateur;
  const { nom, prenom, indicatif, numeroTelephone } = req.body;
  const piece = req.file;
  if (!nom || !prenom || !indicatif || !numeroTelephone || !piece) {
    return res.status(400).send(page("Erreur", `<h1>Merci de remplir tous les champs</h1><a href="/compte/profil">← Retour</a>`));
  }
  u.nom = nom;
  u.prenom = prenom;
  u.telephone = `${indicatif} ${numeroTelephone}`;
  u.pieceIdentite = piece.filename;
  u.telephoneVerifie = false;
  u.codeTelephone = genererCode();
  u.raisonRefus = null;
  sauvegarderJSON(FICHIER_UTILISATEURS, utilisateurs);
  res.redirect("/compte/profil/verifier-telephone");
});

app.get("/compte/profil/verifier-telephone", exigerConnexion, exigerEmailVerifie, (req, res) => {
  const u = req.utilisateur;
  if (!u.codeTelephone) return res.redirect("/compte/profil");
  const contenu = `
    ${entete("profil", u)}
    <h1>Confirmez votre téléphone</h1>
    <p class="souligne">Un code a été "envoyé" par SMS à ${u.telephone}.</p>
    <div class="banniere banniere-attente">Code de démonstration (pas de service SMS réel connecté) : <b style="font-size:18px;">${u.codeTelephone}</b></div>
    <div class="carte">
      <form method="POST" action="/compte/profil/verifier-telephone">
        <label for="code">Code à 6 chiffres</label>
        <input type="text" id="code" name="code" maxlength="6" required>
        <button type="submit">Confirmer</button>
      </form>
    </div>
    <a class="lien-discret" href="/compte/profil/verifier-telephone/renvoyer">Renvoyer un code</a>
  `;
  res.send(page("Confirmer le téléphone", contenu));
});
app.post("/compte/profil/verifier-telephone", exigerConnexion, exigerEmailVerifie, (req, res) => {
  const u = req.utilisateur;
  if (req.body.code !== u.codeTelephone) {
    return res.status(400).send(page("Erreur", `<h1>Code incorrect</h1><a href="/compte/profil/verifier-telephone">← Réessayer</a>`));
  }
  u.telephoneVerifie = true;
  u.codeTelephone = null;
  u.statutVerification = "en_attente";
  sauvegarderJSON(FICHIER_UTILISATEURS, utilisateurs);
  res.redirect("/compte");
});
app.get("/compte/profil/verifier-telephone/renvoyer", exigerConnexion, exigerEmailVerifie, (req, res) => {
  if (req.utilisateur.codeTelephone) req.utilisateur.codeTelephone = genererCode();
  sauvegarderJSON(FICHIER_UTILISATEURS, utilisateurs);
  res.redirect("/compte/profil/verifier-telephone");
});

app.post("/compte/profil/changer-email", exigerConnexion, exigerEmailVerifie, (req, res) => {
  const { nouvelEmail } = req.body;
  if (!nouvelEmail) return res.redirect("/compte/profil");
  if (utilisateurs.some((x) => x.identifiant.toLowerCase() === nouvelEmail.toLowerCase())) {
    return res.status(400).send(page("Erreur", `<h1>Cet e-mail est déjà utilisé</h1><a href="/compte/profil">← Retour</a>`));
  }
  req.utilisateur.emailEnAttente = nouvelEmail;
  req.utilisateur.codeNouvelEmail = genererCode();
  sauvegarderJSON(FICHIER_UTILISATEURS, utilisateurs);
  res.redirect("/compte/profil/confirmer-nouvel-email");
});
app.get("/compte/profil/confirmer-nouvel-email", exigerConnexion, exigerEmailVerifie, (req, res) => {
  const u = req.utilisateur;
  if (!u.emailEnAttente) return res.redirect("/compte/profil");
  const contenu = `
    ${entete("profil", u)}
    <h1>Confirmez votre nouvel e-mail</h1>
    <p class="souligne">Un code a été "envoyé" à ${u.emailEnAttente}.</p>
    <div class="banniere banniere-attente">Code de démonstration : <b style="font-size:18px;">${u.codeNouvelEmail}</b></div>
    <div class="carte">
      <form method="POST" action="/compte/profil/confirmer-nouvel-email">
        <label for="code">Code à 6 chiffres</label>
        <input type="text" id="code" name="code" maxlength="6" required>
        <button type="submit">Confirmer</button>
      </form>
    </div>
  `;
  res.send(page("Confirmer le nouvel e-mail", contenu));
});
app.post("/compte/profil/confirmer-nouvel-email", exigerConnexion, exigerEmailVerifie, (req, res) => {
  const u = req.utilisateur;
  if (req.body.code !== u.codeNouvelEmail) {
    return res.status(400).send(page("Erreur", `<h1>Code incorrect</h1><a href="/compte/profil/confirmer-nouvel-email">← Réessayer</a>`));
  }
  u.identifiant = u.emailEnAttente;
  u.emailEnAttente = null;
  u.codeNouvelEmail = null;
  sauvegarderJSON(FICHIER_UTILISATEURS, utilisateurs);
  res.redirect("/compte/profil");
});

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
    <div class="banniere banniere-erreur">Cette action est définitive et irréversible. Toutes vos données seront effacées.</div>
    <form method="POST" action="/compte/supprimer-compte">
      <button type="submit" class="danger">Oui, supprimer définitivement mon compte</button>
    </form>
    <a class="lien-discret" href="/compte/profil">← Annuler</a>
  `;
  res.send(page("Supprimer mon compte", contenu));
});
app.post("/compte/supprimer-compte", exigerConnexion, (req, res) => {
  utilisateurs = utilisateurs.filter((u) => u.id !== req.utilisateur.id);
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
  const contenu = `
    ${entete("accueil", req.utilisateur)}
    ${stepper(1, ETAPES)}
    <h1>Recharger mon Alipay</h1>
    <p class="souligne">Minimum : ${CONFIG.MONTANT_MIN_RMB} RMB (${(CONFIG.MONTANT_MIN_RMB * CONFIG.TAUX_CHANGE).toLocaleString("fr-FR")} F CFA)</p>
    <div class="carte">
      <form method="POST" action="/compte/nouvelle-demande" enctype="multipart/form-data">
        <label for="montantRMB">Montant à recevoir sur Alipay (RMB)</label>
        <input type="number" id="montantRMB" name="montantRMB" min="${CONFIG.MONTANT_MIN_RMB}" step="0.01" required oninput="majApercu()">
        <p class="souligne" id="apercuMontant" style="margin:6px 0 0;">Taux indicatif : 1 RMB ≈ ${CONFIG.TAUX_CHANGE} F CFA</p>

        <label for="alipayImage">Code QR de votre profil Alipay</label>
        <div class="zone-fichier">
          <input type="file" id="alipayImage" name="alipayImage" accept="image/*" required>
          <p class="indice">Ouvrez Alipay → recevoir de l'argent → capture du QR code</p>
        </div>
        <button type="submit">Continuer</button>
      </form>
    </div>
    <script>
      function majApercu() {
        const taux = ${CONFIG.TAUX_CHANGE};
        const frais = ${CONFIG.FRAIS_POURCENT};
        const v = parseFloat(document.getElementById('montantRMB').value);
        const apercu = document.getElementById('apercuMontant');
        if (!v || v <= 0) { apercu.textContent = 'Taux indicatif : 1 RMB ≈ ' + taux + ' F CFA'; return; }
        const cfa = Math.round(v * taux);
        const fraisXOF = Math.round(cfa * frais / 100);
        const total = cfa + fraisXOF;
        apercu.textContent = 'Montant à payer : ' + total.toLocaleString('fr-FR') + ' F CFA (frais de ' + frais + '% inclus)';
      }
    </script>
  `;
  res.send(page("Nouvelle recharge", contenu));
});

app.post("/compte/nouvelle-demande", exigerConnexion, exigerEmailVerifie, exigerVerifie, uploadAlipay.single("alipayImage"), (req, res) => {
  const montant = parseFloat(req.body.montantRMB);
  const image = req.file;
  if (!image || !montant || montant < CONFIG.MONTANT_MIN_RMB) {
    return res.status(400).send(page("Erreur", `<h1>Montant invalide</h1><p class="souligne">Le minimum est de ${CONFIG.MONTANT_MIN_RMB} RMB et une image est requise.</p><a href="/compte/nouvelle-demande">← Retour</a>`));
  }

  const estTogo = (req.utilisateur.telephone || "").trim().startsWith("+228");
  const optionsPaiement = Object.entries(CONFIG.PAIEMENT)
    .filter(([, info]) => estTogo || !info.togoUniquement)
    .map(([cle, info]) => `
      <label class="moyen-option" data-cle="${cle}" data-type="${info.typeSaisie}" onclick="selectionnerMoyen(this)">
        <input type="radio" name="moyenPaiement" value="${cle}" required>
        ${info.logo ? `<img src="/logos/${info.logo}" alt="" style="width:50px; height:50px; object-fit:contain; border-radius:2px;">` : ""}
        <span>${info.nom}</span>
      </label>`)
    .join("");

  const contenu = `
    ${entete("accueil", req.utilisateur)}
    ${stepper(2, ETAPES)}
    <h1>Moyen de paiement</h1>
    <p class="souligne">Sélectionnez votre méthode de paiement préférée.${!estTogo ? " Mixx By Yas et Moov Money sont réservés aux numéros togolais." : ""}</p>
    <div class="carte">
      <form method="POST" action="/compte/choisir-paiement">
        <input type="hidden" name="montantRMB" value="${montant}">
        <input type="hidden" name="alipayImage" value="${image.filename}">
        ${optionsPaiement}

        <label for="numeroExpediteur" id="labelNumeroExpediteur">Numéro ou compte utilisé pour le dépôt</label>
        <input type="text" id="numeroExpediteur" name="numeroExpediteur" placeholder="Sélectionnez d'abord un moyen de paiement" required>

        <button type="submit">Continuer</button>
      </form>
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
    </script>
  `;
  res.send(page("Moyen de paiement", contenu));
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

  const montantCFA = Math.round(montant * CONFIG.TAUX_CHANGE);
  const frais = Math.round((montantCFA * CONFIG.FRAIS_POURCENT) / 100);
  const total = montantCFA + frais;

  const contenu = `
    ${entete("accueil", req.utilisateur)}
    ${stepper(3, ETAPES)}
    <h1>Confirmation</h1>
    <div class="carte">
      <div class="ligne"><span>Service</span><b>Alipay</b></div>
      <div class="ligne"><span>Taux appliqué</span><b>1 RMB = ${CONFIG.TAUX_CHANGE} XOF</b></div>
      <div class="ligne"><span>Le bénéficiaire reçoit</span><b>${montant} RMB</b></div>
      <div class="ligne"><span>Frais de service (${CONFIG.FRAIS_POURCENT}%)</span><b>+ ${frais.toLocaleString("fr-FR")} XOF</b></div>
      <div class="ligne"><span>Via</span><b>${info.nom}</b></div>
      <div class="ligne"><span>Numéro utilisé pour le dépôt</span><b>${numeroExpediteur}</b></div>
      <div class="ligne"><span>Total à payer</span><b style="font-size:18px; color:var(--jaune);">${total.toLocaleString("fr-FR")} XOF</b></div>

      <p class="souligne" style="margin:14px 0 0;">Voici le numéro sur lequel il faut transférer les fonds :</p>
      <div class="boite-paiement">
        <div><small>${info.nom}</small><b id="numero-tmp">${info.numero}</b></div>
        <button type="button" class="btn-copier" onclick="copierTexte('numero-tmp')">Copier</button>
      </div>
      ${info.noteFrais ? `<div class="avertissement">⚠️ Important : ne pas ajouter les frais de retrait lors de votre dépôt.</div>` : ""}

      <form method="POST" action="/compte/finaliser-commande">
        <input type="hidden" name="montantRMB" value="${montant}">
        <input type="hidden" name="alipayImage" value="${alipayImage}">
        <input type="hidden" name="moyenPaiement" value="${moyenPaiement}">
        <input type="hidden" name="numeroExpediteur" value="${numeroExpediteur}">
        <button type="submit" class="jaune">J'ai payé</button>
      </form>
    </div>
  `;
  res.send(page("Confirmation", contenu));
});

// C'est cette étape qui crée réellement la transaction. Si le client
// abandonne avant, rien n'est enregistré : il repart de zéro.
app.post("/compte/finaliser-commande", exigerConnexion, exigerEmailVerifie, exigerVerifie, (req, res) => {
  const { montantRMB, alipayImage, moyenPaiement, numeroExpediteur } = req.body;
  const montant = parseFloat(montantRMB);
  if (!montant || !alipayImage || !CONFIG.PAIEMENT[moyenPaiement] || !numeroExpediteur) {
    return res.status(400).send(page("Erreur", `<h1>Requête invalide</h1><a href="/compte/nouvelle-demande">← Recommencer</a>`));
  }

  const montantCFA = Math.round(montant * CONFIG.TAUX_CHANGE);
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
        <div class="ligne"><span>Taux appliqué</span><b>1 RMB = ${CONFIG.TAUX_CHANGE} XOF</b></div>
        <div class="ligne"><span>Le bénéficiaire reçoit</span><b>${t.montantRMB} RMB</b></div>
        <div class="ligne"><span>Frais de service (${CONFIG.FRAIS_POURCENT}%)</span><b>+ ${t.frais.toLocaleString("fr-FR")} XOF</b></div>
        <div class="ligne"><span>Via</span><b>${info.nom}</b></div>
        <div class="ligne"><span>Total à payer</span><b style="font-size:18px; color:var(--jaune);">${t.total.toLocaleString("fr-FR")} XOF</b></div>

        <p class="souligne" style="margin:14px 0 0;">Voici le numéro sur lequel il faut transférer les fonds :</p>
        <div class="boite-paiement">
          <div><small>${info.nom}</small><b id="numero-${t.reference}">${info.numero}</b></div>
          <button type="button" class="btn-copier" onclick="copierTexte('numero-${t.reference}')">Copier</button>
        </div>
        ${info.noteFrais ? `<div class="avertissement">⚠️ Important : ne pas ajouter les frais de retrait lors de votre dépôt.</div>` : ""}

        <a class="bouton jaune" href="/compte/transactions/${t.reference}/preuve">J'ai payé</a>
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
        ${t.recuPDF ? `<a class="bouton jaune" href="/recus/${t.recuPDF}" target="_blank">Télécharger le reçu</a>` : ""}
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
          <p class="indice">JPEG, PNG ou PDF (Max 8 Mo)</p>
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

  t.imagePaiement = req.file.filename;
  t.statut = "preuve_recue";
  t.datePreuve = new Date().toISOString();
  // La fiche interne n'est créée qu'après confirmation par l'admin (pas ici).
  sauvegarderJSON(FICHIER_TRANSACTIONS, transactions);
  ajouterNotification(t.utilisateurId, `Preuve de paiement reçue pour votre recharge de ${t.montantRMB} RMB. En attente de confirmation.`, t.reference);
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
function genererFichePDF(t) {
  return new Promise((resolve, reject) => {
    const chemin = path.join(DOSSIER_FICHES, `${t.reference}.pdf`);
    const doc = new PDFDocument({ margin: 40, size: "A4" });
    const flux = fs.createWriteStream(chemin);
    doc.pipe(flux);
    doc.fontSize(18).fillColor("#2563EB").text(`Fiche interne — ${CONFIG.NOM_SITE}`);
    doc.moveDown(0.8);
    doc.fontSize(11).fillColor("#111");
    doc.text(`Référence : ${t.reference}`);
    doc.text(`Client : ${t.identifiantUtilisateur} — ${t.prenomNomComplet || t.nomUtilisateur}`);
    doc.text(`Montant RMB : ${t.montantRMB}`);
    doc.text(`Total XOF : ${formaterFCFA(t.total)} F CFA`);
    doc.text(`Moyen de paiement : ${CONFIG.PAIEMENT[t.moyenPaiement]?.nom || t.moyenPaiement}`);
    doc.text(`Statut : ${t.statut}`);
    doc.moveDown();
    if (t.alipayImage) {
      doc.fontSize(13).fillColor("#2563EB").text("QR Alipay du client");
      doc.moveDown(0.3);
      try { doc.image(path.join(DOSSIER_UPLOADS_ALIPAY, t.alipayImage), { fit: [480, 550], align: "center" }); } catch (e) {}
    }
    if (t.imagePaiement) {
      doc.addPage();
      doc.fontSize(13).fillColor("#2563EB").text("Preuve de paiement");
      doc.moveDown(0.3);
      try { doc.image(path.join(DOSSIER_UPLOADS_PREUVES, t.imagePaiement), { fit: [480, 650], align: "center" }); } catch (e) {}
    }
    doc.end();
    flux.on("finish", () => resolve(chemin));
    flux.on("error", reject);
  });
}
function genererRecuClient(t) {
  return new Promise((resolve, reject) => {
    const chemin = path.join(DOSSIER_RECUS, `${t.reference}.pdf`);
    const doc = new PDFDocument({ margin: 50, size: "A4" });
    const flux = fs.createWriteStream(chemin);
    doc.pipe(flux);
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

    if (t.alipayImage) {
      doc.fontSize(10).fillColor("#2563EB").text("Code QR Alipay", xGauche, yImages, { width: largeurColonne, align: "center" });
      try {
        doc.image(path.join(DOSSIER_UPLOADS_ALIPAY, t.alipayImage), xGauche, yImages + 16, { fit: [largeurColonne, hauteurMax], align: "center" });
      } catch (e) {}
    }
    if (t.imagePaiement) {
      doc.fontSize(10).fillColor("#2563EB").text("Preuve de paiement", xDroite, yImages, { width: largeurColonne, align: "center" });
      try {
        doc.image(path.join(DOSSIER_UPLOADS_PREUVES, t.imagePaiement), xDroite, yImages + 16, { fit: [largeurColonne, hauteurMax], align: "center" });
      } catch (e) {}
    }

    doc.end();
    flux.on("finish", () => resolve(chemin));
    flux.on("error", reject);
  });
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
  res.send(page("Connexion admin", contenu));
});
app.post("/admin/connexion", (req, res) => {
  const { identifiant, motDePasse } = req.body;
  if (identifiant !== CONFIG.ADMIN_IDENTIFIANT || motDePasse !== CONFIG.ADMIN_MOT_DE_PASSE) {
    return res.status(401).send(page("Erreur", `<h1>Identifiant ou mot de passe incorrect</h1><a href="/admin/connexion">← Réessayer</a>`));
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
  `;
  res.send(page("Admin", contenu, { large: true }));
});

app.get("/admin/utilisateurs", exigerAdmin, (req, res) => {
  const lignes = [...utilisateurs].reverse().map((u) => {
    const estPdf = u.pieceIdentite && u.pieceIdentite.toLowerCase().endsWith(".pdf");
    const image = !u.pieceIdentite ? "—" : estPdf
      ? `<a href="/uploads/identite/${u.pieceIdentite}" target="_blank">📄 PDF</a>`
      : `<a href="/uploads/identite/${u.pieceIdentite}" target="_blank"><img class="miniature" src="/uploads/identite/${u.pieceIdentite}"></a>`;
    const infos = u.nom
      ? `${u.prenom} ${u.nom}<br><small style="color:var(--texte-att);">${u.telephone} — ${u.telephoneVerifie ? "✔ tél. vérifié" : "✘ tél. non vérifié"}</small>`
      : `<em>${u.pseudo} (profil incomplet)</em>`;
    const actions = u.statutVerification === "en_attente"
      ? `<form style="display:inline" method="POST" action="/admin/utilisateurs/${u.id}/verifier"><button class="mini-bouton ok">Vérifier</button></form>
         <form style="display:inline" method="POST" action="/admin/utilisateurs/${u.id}/refuser"><button class="mini-bouton refus">Refuser</button></form>`
      : "";
    return `<tr><td>${image}</td><td>${u.identifiant}</td><td>${infos}</td><td><span class="badge badge-${u.statutVerification === "verifie" ? "verifie" : u.statutVerification === "refuse" ? "refuse" : "attente"}">${u.statutVerification.replace(/_/g, " ")}</span></td><td>${actions}</td></tr>`;
  }).join("");

  const contenu = `
    <div class="nav-admin"><a href="/admin">← Accueil admin</a><a href="/admin/transactions">Transactions</a></div>
    <h1>Comptes clients</h1>
    ${utilisateurs.length === 0 ? `<p class="aucune-donnee">Aucun compte.</p>` : `<table class="admin"><thead><tr><th>Pièce</th><th>E-mail</th><th>Infos</th><th>Statut</th><th>Action</th></tr></thead><tbody>${lignes}</tbody></table>`}
  `;
  res.send(page("Comptes clients", contenu, { large: true }));
});
app.post("/admin/utilisateurs/:id/verifier", exigerAdmin, (req, res) => {
  const u = utilisateurs.find((x) => x.id === req.params.id);
  if (u) { u.statutVerification = "verifie"; sauvegarderJSON(FICHIER_UTILISATEURS, utilisateurs); }
  res.redirect("/admin/utilisateurs");
});
app.post("/admin/utilisateurs/:id/refuser", exigerAdmin, (req, res) => {
  const u = utilisateurs.find((x) => x.id === req.params.id);
  if (u) { u.statutVerification = "refuse"; u.raisonRefus = MESSAGE_REFUS_IDENTITE; sauvegarderJSON(FICHIER_UTILISATEURS, utilisateurs); }
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
    const imgAlipay = t.alipayImage ? `<a href="/uploads/alipay/${t.alipayImage}" target="_blank"><img class="miniature" src="/uploads/alipay/${t.alipayImage}"></a>` : "—";
    const estPdf = t.imagePaiement && t.imagePaiement.toLowerCase().endsWith(".pdf");
    const imgPreuve = !t.imagePaiement ? "—" : estPdf ? `<a href="/uploads/preuves/${t.imagePaiement}" target="_blank">📄 PDF</a>` : `<a href="/uploads/preuves/${t.imagePaiement}" target="_blank"><img class="miniature" src="/uploads/preuves/${t.imagePaiement}"></a>`;
    const heurePreuve = t.datePreuve ? new Date(t.datePreuve).toLocaleString("fr-FR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "—";
    const fiche = t.fichePDF ? `<a href="/fiches/${t.fichePDF}" target="_blank">📄</a>` : "—";
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
  res.send(page("Transactions", contenu, { large: true }));
});
app.get("/admin/transactions.json", exigerAdmin, (req, res) => res.json(transactions));

app.post("/admin/transactions/:reference/confirmer-paiement", exigerAdmin, async (req, res) => {
  const t = transactions.find((x) => x.reference === req.params.reference);
  if (t && t.statut === "preuve_recue") {
    t.statut = "paye";
    t.datePaiementConfirme = new Date().toISOString();
    try {
      await genererFichePDF(t);
      t.fichePDF = `${t.reference}.pdf`;
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
      await genererFichePDF(t);
      await genererRecuClient(t);
      t.recuPDF = `${t.reference}.pdf`;
    } catch (e) { console.error(e.message); }
    sauvegarderJSON(FICHIER_TRANSACTIONS, transactions);
    ajouterNotification(t.utilisateurId, `Votre compte Alipay a été crédité de ${t.montantRMB} RMB ✔ Transaction terminée.`, t.reference);
  }
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
// 17) DÉMARRAGE
// ============================================================================
app.listen(CONFIG.PORT, () => {
  console.log(`✅ ${CONFIG.NOM_SITE} lancé sur http://localhost:${CONFIG.PORT}`);
  console.log(`   Admin : http://localhost:${CONFIG.PORT}/admin/connexion (${CONFIG.ADMIN_IDENTIFIANT} / ${CONFIG.ADMIN_MOT_DE_PASSE})`);
});