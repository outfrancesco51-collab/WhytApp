/**
 * WhytApp — Decentralized P2P Messaging & WebRTC Calling Client
 * Powered by PeerJS (DataChannels & MediaStreams) + IndexedDB
 */

(function () {
  "use strict";

  // --- STATO APPLICAZIONE ---
  const STATE = {
    myUsername: localStorage.getItem("whytapp_p2p_username") || "",
    myPeerId: "",
    peer: null,
    activeFriendId: null, // peerId dell'amico attualmente aperto in chat
    connections: new Map(), // peerId -> DataConnection
    friends: [], // array di { id, username, lastSeen, unread }
    
    // WebRTC Media Call State
    activeCall: null,
    localStream: null,
    remoteStream: null,
    isAudioMuted: false,
    isVideoOff: false,
    isScreenSharing: false,
    callTimerInterval: null,
    callDurationSec: 0,
    incomingCallInstance: null,

    typingTimeout: null,
    audioContext: null
  };

  // --- GESTIONE INDEXEDDB PER PERSISTENZA CHAT LOCALE ---
  const DB_CONFIG = {
    name: "WhytApp_P2P_Storage",
    version: 1,
    store: "chat_history"
  };

  function openIndexedDB() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_CONFIG.name, DB_CONFIG.version);
      request.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(DB_CONFIG.store)) {
          const store = db.createObjectStore(DB_CONFIG.store, { keyPath: "id", autoIncrement: true });
          store.createIndex("by_peer", "peerId", { unique: false });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async function saveMessageToDB(msg) {
    try {
      const db = await openIndexedDB();
      const tx = db.transaction(DB_CONFIG.store, "readwrite");
      tx.objectStore(DB_CONFIG.store).add(msg);
    } catch (err) {
      console.warn("Errore salvataggio IndexedDB:", err);
    }
  }

  async function getChatHistoryFromDB(peerId) {
    try {
      const db = await openIndexedDB();
      return new Promise((resolve) => {
        const tx = db.transaction(DB_CONFIG.store, "readonly");
        const index = tx.objectStore(DB_CONFIG.store).index("by_peer");
        const request = index.getAll(IDBKeyRange.only(peerId));
        request.onsuccess = () => resolve(request.result || []);
        request.onerror = () => resolve([]);
      });
    } catch (err) {
      return [];
    }
  }

  // --- ELEMENTI DOM ---
  const DOM = {
    networkStatusIndicator: document.getElementById("network-status-indicator"),
    copyMyIdBtn: document.getElementById("copy-my-id-btn"),
    myIdContainer: document.getElementById("my-id-container"),
    myPeerIdDisplay: document.getElementById("my-peer-id-display"),
    friendSearchInput: document.getElementById("friend-search-input"),
    friendsList: document.getElementById("friends-list"),
    openAddModalMini: document.getElementById("open-add-modal-mini"),
    myAvatar: document.getElementById("my-avatar"),
    myOnlineDot: document.getElementById("my-online-dot"),
    myUsernameDisplay: document.getElementById("my-username-display"),
    mySubstatus: document.getElementById("my-substatus"),
    btnSelfProfile: document.getElementById("btn-self-profile"),

    // Chat Viewport
    chatHeader: document.getElementById("chat-header"),
    activeChatAvatar: document.getElementById("active-chat-avatar"),
    activeChatName: document.getElementById("active-chat-name"),
    activeChatStatus: document.getElementById("active-chat-status"),
    chatHeaderActions: document.getElementById("chat-header-actions"),
    btnStartAudioCall: document.getElementById("btn-start-audio-call"),
    btnStartVideoCall: document.getElementById("btn-start-video-call"),
    btnStartScreenCall: document.getElementById("btn-start-screen-call"),
    btnDisconnectPeer: document.getElementById("btn-disconnect-peer"),

    messagesContainer: document.getElementById("messages-container"),
    emptyChatState: document.getElementById("empty-chat-state"),
    messagesStream: document.getElementById("messages-stream"),
    typingIndicator: document.getElementById("typing-indicator"),
    typingText: document.getElementById("typing-text"),
    dropZoneOverlay: document.getElementById("drop-zone-overlay"),
    messageInput: document.getElementById("message-input"),
    btnSendMessage: document.getElementById("btn-send-message"),
    btnAttachMedia: document.getElementById("btn-attach-media"),
    mediaInput: document.getElementById("media-input"),

    // Call Overlay
    callOverlay: document.getElementById("call-overlay"),
    callStatusLabel: document.getElementById("call-status-label"),
    callTimer: document.getElementById("call-timer"),
    localVideo: document.getElementById("local-video"),
    remoteVideo: document.getElementById("remote-video"),
    remotePlaceholder: document.getElementById("remote-placeholder"),
    remoteAvatarPlaceholder: document.getElementById("remote-avatar-placeholder"),
    remotePlaceholderName: document.getElementById("remote-placeholder-name"),
    remoteUserTag: document.getElementById("remote-user-tag"),
    localPlaceholder: document.getElementById("local-placeholder"),
    btnToggleMic: document.getElementById("btn-toggle-mic"),
    btnToggleCamera: document.getElementById("btn-toggle-camera"),
    btnToggleScreenshare: document.getElementById("btn-toggle-screenshare"),
    btnHangupCall: document.getElementById("btn-hangup-call"),

    // Modals & Banners
    onboardingModal: document.getElementById("onboarding-modal"),
    onboardingForm: document.getElementById("onboarding-form"),
    inputUsername: document.getElementById("input-username"),

    addFriendModal: document.getElementById("add-friend-modal"),
    addFriendForm: document.getElementById("add-friend-form"),
    inputFriendId: document.getElementById("input-friend-id"),
    inputFriendNickname: document.getElementById("input-friend-nickname"),
    btnCloseAddModal: document.getElementById("btn-close-add-modal"),
    btnCancelAddFriend: document.getElementById("btn-cancel-add-friend"),
    btnWelcomeAddFriend: document.getElementById("btn-welcome-add-friend"),

    incomingCallBanner: document.getElementById("incoming-call-banner"),
    incomingCallerAvatar: document.getElementById("incoming-caller-avatar"),
    incomingCallerName: document.getElementById("incoming-caller-name"),
    incomingCallType: document.getElementById("incoming-call-type"),
    btnAcceptCall: document.getElementById("btn-accept-call"),
    btnDeclineCall: document.getElementById("btn-decline-call"),

    lightboxModal: document.getElementById("lightbox-modal"),
    lightboxImg: document.getElementById("lightbox-img"),
    lightboxCaption: document.getElementById("lightbox-caption"),
    btnCloseLightbox: document.getElementById("btn-close-lightbox"),

    toastContainer: document.getElementById("toast-container"),
    guildAddFriendBtn: document.getElementById("guild-add-friend-btn"),
    guildSettingsBtn: document.getElementById("guild-settings-btn")
  };

  // --- FEEDBACK AUDIO SINTETICO TRAMITE WEB AUDIO API (Zero file audio esterni) ---
  function playNotificationBeep(type = "message") {
    try {
      const ctx = STATE.audioContext || new (window.AudioContext || window.webkitAudioContext)();
      STATE.audioContext = ctx;
      if (ctx.state === "suspended") ctx.resume();

      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);

      const now = ctx.currentTime;
      if (type === "message") {
        osc.type = "sine";
        osc.frequency.setValueAtTime(587.33, now); // D5
        osc.frequency.exponentialRampToValueAtTime(880, now + 0.12); // A5
        gain.gain.setValueAtTime(0.15, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.25);
        osc.start(now);
        osc.stop(now + 0.25);
      } else if (type === "ringtone") {
        osc.type = "triangle";
        osc.frequency.setValueAtTime(440, now);
        osc.frequency.setValueAtTime(480, now + 0.15);
        gain.gain.setValueAtTime(0.2, now);
        gain.gain.exponentialRampToValueAtTime(0.01, now + 0.5);
        osc.start(now);
        osc.stop(now + 0.5);
      }
    } catch (e) {
      // Nessun blocco se l'interazione utente non è ancora avvenuta
    }
  }

  // --- GESTIONE TOAST NOTIFICHE ---
  function showToast(text, type = "info") {
    const toast = document.createElement("div");
    toast.className = "toast";
    toast.innerHTML = `<span>${escapeHtml(text)}</span>`;
    DOM.toastContainer.appendChild(toast);

    setTimeout(() => {
      toast.style.opacity = "0";
      toast.style.transform = "translateY(10px)";
      setTimeout(() => toast.remove(), 300);
    }, 3200);
  }

  function escapeHtml(t) {
    if (!t) return "";
    const div = document.createElement("div");
    div.textContent = t;
    return div.innerHTML;
  }

  // --- GESTIONE AMICI IN LOCALSTORAGE ---
  function loadFriendsFromStorage() {
    try {
      const raw = localStorage.getItem("whytapp_friends");
      STATE.friends = raw ? JSON.parse(raw) : [];
    } catch (e) {
      STATE.friends = [];
    }
    renderFriendsList();
  }

  function saveFriendsToStorage() {
    localStorage.setItem("whytapp_friends", JSON.stringify(STATE.friends));
  }

  function addOrUpdateFriend(peerId, customUsername = "") {
    let friend = STATE.friends.find(f => f.id === peerId);
    if (!friend) {
      friend = {
        id: peerId,
        username: customUsername || `@${peerId.substring(0, 8)}`,
        isOnline: false,
        unread: 0
      };
      STATE.friends.push(friend);
    } else if (customUsername) {
      friend.username = customUsername;
    }
    saveFriendsToStorage();
    renderFriendsList();
    return friend;
  }

  function renderFriendsList() {
    const filter = DOM.friendSearchInput.value.trim().toLowerCase();
    DOM.friendsList.innerHTML = "";

    const filtered = STATE.friends.filter(f => 
      !filter || f.username.toLowerCase().includes(filter) || f.id.toLowerCase().includes(filter)
    );

    if (filtered.length === 0) {
      const emptyLi = document.createElement("li");
      emptyLi.style.padding = "16px";
      emptyLi.style.textAlign = "center";
      emptyLi.style.color = "var(--text-muted)";
      emptyLi.style.fontSize = "13px";
      emptyLi.textContent = filter ? "Nessun amico trovato" : "Nessun amico collegato. Clicca su + per aggiungere un ID.";
      DOM.friendsList.appendChild(emptyLi);
      return;
    }

    filtered.forEach(friend => {
      const li = document.createElement("li");
      li.className = `friend-item ${STATE.activeFriendId === friend.id ? "active" : ""}`;
      
      const isConnected = STATE.connections.has(friend.id);
      const initial = friend.username.replace("@", "").charAt(0).toUpperCase() || "?";

      li.innerHTML = `
        <div class="friend-avatar-wrap">
          <div class="avatar">${initial}</div>
          <span class="status-dot ${isConnected ? "online" : ""}"></span>
        </div>
        <div class="friend-info">
          <div class="friend-name-row">
            <span class="friend-name">${escapeHtml(friend.username)}</span>
            ${friend.unread > 0 ? `<span class="unread-badge">${friend.unread}</span>` : ""}
          </div>
          <div class="friend-subtext">${isConnected ? "P2P Connesso" : "In attesa di connessione..."}</div>
        </div>
      `;

      li.onclick = () => selectFriendChat(friend.id);
      DOM.friendsList.appendChild(li);
    });

    if (window.lucide) window.lucide.createIcons();
  }

  DOM.friendSearchInput.addEventListener("input", renderFriendsList);

  // --- SELEZIONE DELLA CHAT ATTIVA ---
  async function selectFriendChat(peerId) {
    STATE.activeFriendId = peerId;
    const friend = STATE.friends.find(f => f.id === peerId);
    if (friend) {
      friend.unread = 0;
      saveFriendsToStorage();
    }

    renderFriendsList();

    // Aggiorna Header
    const initial = friend ? friend.username.replace("@", "").charAt(0).toUpperCase() : "?";
    DOM.activeChatAvatar.textContent = initial;
    DOM.activeChatName.textContent = friend ? friend.username : peerId;
    
    const isConn = STATE.connections.has(peerId);
    DOM.activeChatStatus.textContent = isConn ? "Connessione crittografata WebRTC attiva" : "Tentativo di connessione P2P...";
    DOM.chatHeaderActions.style.display = isConn ? "flex" : "none";

    DOM.messageInput.disabled = !isConn;
    DOM.btnSendMessage.disabled = !isConn;
    DOM.messageInput.placeholder = isConn ? `Invia un messaggio a ${friend ? friend.username : peerId}...` : "Connessione all'amico in corso...";

    // Mostra Area Messaggi
    DOM.emptyChatState.style.display = "none";
    DOM.messagesStream.style.display = "flex";
    DOM.messagesStream.innerHTML = "";

    // Carica cronologia da IndexedDB
    const history = await getChatHistoryFromDB(peerId);
    history.forEach(m => renderSingleMessage(m));
    DOM.messagesContainer.scrollTop = DOM.messagesContainer.scrollHeight;

    // Se non siamo ancora connessi con questo amico, tentiamo la connessione P2P
    if (!isConn) {
      connectToPeer(peerId);
    }
  }

  // --- GESTIONE PEERJS P2P (Signaling & DataChannel) ---
  function initPeerClient() {
    if (STATE.peer) STATE.peer.destroy();

    // Genera ID parlante: whytapp-{username}-{random}
    const cleanUser = STATE.myUsername.replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
    const desiredId = `whytapp-${cleanUser}-${Math.random().toString(36).substr(2, 6)}`;

    DOM.myPeerIdDisplay.textContent = "Connessione al server P2P...";

    STATE.peer = new Peer(desiredId, {
      debug: 1,
      config: {
        iceServers: [
          { urls: "stun:stun.l.google.com:19302" },
          { urls: "stun:stun1.l.google.com:19302" },
          { urls: "stun:stun2.l.google.com:19302" }
        ]
      }
    });

    STATE.peer.on("open", (id) => {
      STATE.myPeerId = id;
      DOM.myPeerIdDisplay.textContent = id;
      DOM.networkStatusIndicator.title = "Stato Rete P2P: Connesso & Pronto";
      DOM.networkStatusIndicator.querySelector(".status-pulse").classList.remove("offline");
      showToast(`Connesso alla rete P2P con ID: ${id}`);
      
      // Riconnetti gli amici salvati
      STATE.friends.forEach(f => connectToPeer(f.id));
    });

    STATE.peer.on("connection", (conn) => {
      setupDataConnection(conn);
    });

    STATE.peer.on("call", (mediaCall) => {
      handleIncomingMediaCall(mediaCall);
    });

    STATE.peer.on("error", (err) => {
      console.warn("[PeerJS Error]:", err);
      showToast(`Avviso P2P: ${err.type || err.message}`);
    });

    STATE.peer.on("disconnected", () => {
      DOM.networkStatusIndicator.querySelector(".status-pulse").classList.add("offline");
    });
  }

  // Connessione dati P2P verso un altro Peer
  function connectToPeer(targetPeerId) {
    if (!STATE.peer || !STATE.myPeerId || targetPeerId === STATE.myPeerId) return;
    if (STATE.connections.has(targetPeerId)) return;

    const conn = STATE.peer.connect(targetPeerId, {
      reliable: true,
      metadata: { username: STATE.myUsername }
    });

    setupDataConnection(conn);
  }

  function setupDataConnection(conn) {
    conn.on("open", () => {
      STATE.connections.set(conn.peer, conn);
      
      // Aggiorna o registra amico
      const remoteUser = (conn.metadata && conn.metadata.username) ? conn.metadata.username : "";
      addOrUpdateFriend(conn.peer, remoteUser);

      // Invia il proprio profilo come handshake
      conn.send({
        type: "handshake",
        username: STATE.myUsername
      });

      if (STATE.activeFriendId === conn.peer) {
        selectFriendChat(conn.peer);
      }
      renderFriendsList();
      showToast(`Connessione P2P stabilita con ${remoteUser || conn.peer}`);
    });

    conn.on("data", (data) => {
      handleIncomingData(conn.peer, data);
    });

    conn.on("close", () => {
      STATE.connections.delete(conn.peer);
      renderFriendsList();
      if (STATE.activeFriendId === conn.peer) {
        DOM.activeChatStatus.textContent = "Connessione P2P interrotta";
        DOM.messageInput.disabled = true;
        DOM.btnSendMessage.disabled = true;
        DOM.chatHeaderActions.style.display = "none";
      }
    });

    conn.on("error", () => {
      STATE.connections.delete(conn.peer);
      renderFriendsList();
    });
  }

  // Ricezione pacchetti P2P
  function handleIncomingData(peerId, data) {
    if (!data || !data.type) return;

    switch (data.type) {
      case "handshake":
        if (data.username) {
          addOrUpdateFriend(peerId, data.username);
          if (STATE.activeFriendId === peerId) {
            DOM.activeChatName.textContent = data.username;
          }
        }
        break;

      case "typing":
        if (STATE.activeFriendId === peerId) {
          showTypingIndicator(data.username || "L'amico");
        }
        break;

      case "text_message":
      case "media_message":
        const msgObj = {
          peerId: peerId,
          sender: data.sender || peerId,
          isMine: false,
          type: data.type,
          content: data.content || "",
          mediaData: data.mediaData || "", // Base64
          mediaName: data.mediaName || "allegato",
          timestamp: data.timestamp || getCurrentTime()
        };

        saveMessageToDB(msgObj);

        if (STATE.activeFriendId === peerId) {
          renderSingleMessage(msgObj);
          DOM.messagesContainer.scrollTop = DOM.messagesContainer.scrollHeight;
        } else {
          // Incrementa non letti
          const fr = STATE.friends.find(f => f.id === peerId);
          if (fr) {
            fr.unread = (fr.unread || 0) + 1;
            saveFriendsToStorage();
            renderFriendsList();
          }
        }

        playNotificationBeep("message");
        break;
    }
  }

  function getCurrentTime() {
    const d = new Date();
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }

  function showTypingIndicator(username) {
    DOM.typingText.textContent = `${username} sta scrivendo...`;
    DOM.typingIndicator.style.display = "flex";
    if (STATE.typingTimeout) clearTimeout(STATE.typingTimeout);
    STATE.typingTimeout = setTimeout(() => {
      DOM.typingIndicator.style.display = "none";
    }, 2500);
  }

  // --- RENDERING DEI MESSAGGI & HIGHLIGHT MENZIONI @ ---
  function renderSingleMessage(msg) {
    const row = document.createElement("div");
    row.className = "message-row";

    const initial = msg.sender.replace("@", "").charAt(0).toUpperCase();

    let mediaHtml = "";
    if (msg.mediaData) {
      mediaHtml = `
        <img class="message-media-attachment" src="${msg.mediaData}" alt="${escapeHtml(msg.mediaName)}" loading="lazy">
      `;
    }

    let textHtml = "";
    if (msg.content) {
      textHtml = `<div class="message-bubble">${formatMentions(msg.content)}</div>`;
    }

    row.innerHTML = `
      <div class="message-avatar">${initial}</div>
      <div class="message-content-wrap">
        <div class="message-header-row">
          <span class="message-sender">${escapeHtml(msg.sender)}</span>
          <span class="message-time">${escapeHtml(msg.timestamp)}</span>
        </div>
        ${textHtml}
        ${mediaHtml}
      </div>
    `;

    // Click sull'immagine per ingrandire con Lightbox
    const imgElem = row.querySelector(".message-media-attachment");
    if (imgElem) {
      imgElem.onclick = () => openLightbox(msg.mediaData, msg.mediaName);
    }

    DOM.messagesStream.appendChild(row);
  }

  // Evidenziazione grafica automatica delle menzioni @username
  function formatMentions(text) {
    const esc = escapeHtml(text);
    return esc.replace(/@([a-zA-Z0-9_-]+)/g, (match) => {
      return `<span class="mention" title="Menzione">${match}</span>`;
    });
  }

  // --- INVIO MESSAGGI DI TESTO ---
  function sendMessage() {
    const text = DOM.messageInput.value.trim();
    if (!text || !STATE.activeFriendId) return;

    const conn = STATE.connections.get(STATE.activeFriendId);
    if (!conn) {
      showToast("Connessione con questo amico non disponibile");
      return;
    }

    const payload = {
      type: "text_message",
      sender: STATE.myUsername,
      content: text,
      timestamp: getCurrentTime()
    };

    conn.send(payload);

    const localMsg = {
      peerId: STATE.activeFriendId,
      sender: STATE.myUsername,
      isMine: true,
      type: "text_message",
      content: text,
      timestamp: payload.timestamp
    };

    saveMessageToDB(localMsg);
    renderSingleMessage(localMsg);
    DOM.messagesContainer.scrollTop = DOM.messagesContainer.scrollHeight;

    DOM.messageInput.value = "";
    DOM.messageInput.focus();
  }

  DOM.btnSendMessage.addEventListener("click", sendMessage);
  DOM.messageInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    } else {
      // Invia segnale "sta scrivendo..." all'interlocutore
      const conn = STATE.connections.get(STATE.activeFriendId);
      if (conn) {
        conn.send({ type: "typing", username: STATE.myUsername });
      }
    }
  });

  // --- INVIO IMMAGINI E GIF (FILE PICKER, DRAG & DROP, PASTE CTRL+V) ---
  DOM.btnAttachMedia.addEventListener("click", () => DOM.mediaInput.click());
  DOM.mediaInput.addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (file) {
      processAndSendMediaFile(file);
      DOM.mediaInput.value = "";
    }
  });

  // Drag & Drop
  const container = DOM.messagesContainer;
  ["dragenter", "dragover"].forEach(eventName => {
    container.addEventListener(eventName, (e) => {
      e.preventDefault();
      e.stopPropagation();
      DOM.dropZoneOverlay.classList.add("drag-active");
    });
  });

  ["dragleave", "drop"].forEach(eventName => {
    container.addEventListener(eventName, (e) => {
      e.preventDefault();
      e.stopPropagation();
      DOM.dropZoneOverlay.classList.remove("drag-active");
    });
  });

  container.addEventListener("drop", (e) => {
    const files = e.dataTransfer.files;
    if (files && files[0]) {
      processAndSendMediaFile(files[0]);
    }
  });

  // Paste Ctrl+V
  window.addEventListener("paste", (e) => {
    const items = (e.clipboardData || e.originalEvent.clipboardData).items;
    for (let item of items) {
      if (item.type.indexOf("image") === 0) {
        const file = item.getAsFile();
        if (file) {
          e.preventDefault();
          processAndSendMediaFile(file);
          return;
        }
      }
    }
  });

  function processAndSendMediaFile(file) {
    if (!STATE.activeFriendId) {
      showToast("Seleziona prima una chat per inviare l'immagine");
      return;
    }

    const conn = STATE.connections.get(STATE.activeFriendId);
    if (!conn) {
      showToast("Peer non connesso. Impossibile inviare media.");
      return;
    }

    // Limite P2P consigliato per DataChannel: 8MB
    if (file.size > 8 * 1024 * 1024) {
      showToast("Dimensione massima per allegati P2P: 8MB");
      return;
    }

    showToast("Compressione e invio P2P dell'immagine...");

    const reader = new FileReader();
    reader.onload = (event) => {
      const base64Data = event.target.result;
      const payload = {
        type: "media_message",
        sender: STATE.myUsername,
        content: DOM.messageInput.value.trim(),
        mediaData: base64Data,
        mediaName: file.name,
        timestamp: getCurrentTime()
      };

      conn.send(payload);

      const localMsg = {
        peerId: STATE.activeFriendId,
        sender: STATE.myUsername,
        isMine: true,
        type: "media_message",
        content: payload.content,
        mediaData: base64Data,
        mediaName: file.name,
        timestamp: payload.timestamp
      };

      saveMessageToDB(localMsg);
      renderSingleMessage(localMsg);
      DOM.messagesContainer.scrollTop = DOM.messagesContainer.scrollHeight;
      DOM.messageInput.value = "";
    };
    reader.readAsDataURL(file);
  }

  // --- LIGHTBOX INGRANDIMENTO IMMAGINI ---
  function openLightbox(src, caption) {
    DOM.lightboxImg.src = src;
    DOM.lightboxCaption.textContent = caption || "";
    DOM.lightboxModal.style.display = "flex";
  }

  DOM.btnCloseLightbox.addEventListener("click", () => {
    DOM.lightboxModal.style.display = "none";
  });
  DOM.lightboxModal.addEventListener("click", (e) => {
    if (e.target === DOM.lightboxModal) {
      DOM.lightboxModal.style.display = "none";
    }
  });

  // --- CHIAMATE AUDIO, VIDEO E SCREEN SHARE (WEBRTC MEDIA STREAMS) ---
  DOM.btnStartAudioCall.addEventListener("click", () => startCallWithActivePeer("audio"));
  DOM.btnStartVideoCall.addEventListener("click", () => startCallWithActivePeer("video"));
  DOM.btnStartScreenCall.addEventListener("click", () => startCallWithActivePeer("screen"));

  async function startCallWithActivePeer(callType) {
    if (!STATE.activeFriendId) return;

    try {
      showToast(`Avvio chiamata ${callType}...`);
      if (callType === "screen") {
        STATE.localStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
      } else {
        STATE.localStream = await navigator.mediaDevices.getUserMedia({
          audio: true,
          video: (callType === "video")
        });
      }

      DOM.localVideo.srcObject = STATE.localStream;
      openCallOverlay(STATE.activeFriendId, callType);

      const call = STATE.peer.call(STATE.activeFriendId, STATE.localStream, {
        metadata: {
          username: STATE.myUsername,
          callType: callType
        }
      });

      bindMediaCallEvents(call);
    } catch (err) {
      console.warn("Permesso multimediale negato o errore:", err);
      showToast("Accesso a microfono/videocamera negato.");
    }
  }

  function handleIncomingMediaCall(call) {
    STATE.incomingCallInstance = call;
    const callerId = call.peer;
    const meta = call.metadata || {};
    const callerName = meta.username || `@${callerId.substring(0, 8)}`;
    const callType = meta.callType === "video" ? "Videochiamata" : (meta.callType === "screen" ? "Condivisione Schermo" : "Chiamata Vocale");

    DOM.incomingCallerAvatar.textContent = callerName.replace("@", "").charAt(0).toUpperCase();
    DOM.incomingCallerName.textContent = callerName;
    DOM.incomingCallType.textContent = `${callType} in arrivo...`;

    DOM.incomingCallBanner.style.display = "flex";
    playNotificationBeep("ringtone");
  }

  DOM.btnAcceptCall.addEventListener("click", async () => {
    const call = STATE.incomingCallInstance;
    if (!call) return;
    DOM.incomingCallBanner.style.display = "none";

    const callType = (call.metadata && call.metadata.callType) ? call.metadata.callType : "audio";

    try {
      STATE.localStream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: (callType === "video")
      });
      DOM.localVideo.srcObject = STATE.localStream;

      openCallOverlay(call.peer, callType);
      call.answer(STATE.localStream);
      bindMediaCallEvents(call);
    } catch (err) {
      console.warn("Impossibile acquisire dispositivi locali:", err);
      // Rispondi comunque con stream vuoto
      const emptyStream = new MediaStream();
      call.answer(emptyStream);
      openCallOverlay(call.peer, callType);
      bindMediaCallEvents(call);
    }
  });

  DOM.btnDeclineCall.addEventListener("click", () => {
    if (STATE.incomingCallInstance) {
      STATE.incomingCallInstance.close();
      STATE.incomingCallInstance = null;
    }
    DOM.incomingCallBanner.style.display = "none";
  });

  function bindMediaCallEvents(call) {
    STATE.activeCall = call;

    call.on("stream", (remoteStream) => {
      STATE.remoteStream = remoteStream;
      DOM.remoteVideo.srcObject = remoteStream;
      DOM.remotePlaceholder.style.display = "none";
    });

    call.on("close", () => {
      terminateCall();
    });

    call.on("error", () => {
      terminateCall();
    });

    startCallTimer();
  }

  function openCallOverlay(peerId, callType) {
    DOM.callOverlay.style.display = "flex";
    const friend = STATE.friends.find(f => f.id === peerId);
    const displayName = friend ? friend.username : peerId;
    DOM.callStatusLabel.textContent = `In chiamata con ${displayName}`;
    DOM.remoteUserTag.textContent = displayName;
    DOM.remotePlaceholderName.textContent = displayName;
    DOM.remoteAvatarPlaceholder.textContent = displayName.replace("@", "").charAt(0).toUpperCase();

    // Toggle pulsanti iniziali
    STATE.isAudioMuted = false;
    STATE.isVideoOff = (callType === "audio");
    DOM.btnToggleMic.classList.remove("active");
    DOM.btnToggleCamera.classList.toggle("active", STATE.isVideoOff);
  }

  function terminateCall() {
    if (STATE.activeCall) {
      STATE.activeCall.close();
      STATE.activeCall = null;
    }
    if (STATE.localStream) {
      STATE.localStream.getTracks().forEach(t => t.stop());
      STATE.localStream = null;
    }
    if (STATE.remoteStream) {
      STATE.remoteStream.getTracks().forEach(t => t.stop());
      STATE.remoteStream = null;
    }

    clearInterval(STATE.callTimerInterval);
    STATE.callDurationSec = 0;
    DOM.callTimer.textContent = "00:00";

    DOM.callOverlay.style.display = "none";
    DOM.remoteVideo.srcObject = null;
    DOM.localVideo.srcObject = null;
    DOM.remotePlaceholder.style.display = "flex";
  }

  DOM.btnHangupCall.addEventListener("click", terminateCall);

  DOM.btnToggleMic.addEventListener("click", () => {
    if (!STATE.localStream) return;
    STATE.isAudioMuted = !STATE.isAudioMuted;
    STATE.localStream.getAudioTracks().forEach(t => t.enabled = !STATE.isAudioMuted);
    DOM.btnToggleMic.classList.toggle("active", STATE.isAudioMuted);
    showToast(STATE.isAudioMuted ? "Microfono disattivato" : "Microfono attivo");
  });

  DOM.btnToggleCamera.addEventListener("click", async () => {
    if (!STATE.localStream) return;
    STATE.isVideoOff = !STATE.isVideoOff;
    STATE.localStream.getVideoTracks().forEach(t => t.enabled = !STATE.isVideoOff);
    DOM.btnToggleCamera.classList.toggle("active", STATE.isVideoOff);
    DOM.localPlaceholder.style.display = STATE.isVideoOff ? "flex" : "none";
  });

  DOM.btnToggleScreenshare.addEventListener("click", async () => {
    if (!STATE.activeCall) return;

    try {
      const screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
      const screenTrack = screenStream.getVideoTracks()[0];

      // Sostituisci il track del sender WebRTC
      const sender = STATE.activeCall.peerConnection.getSenders().find(s => s.track && s.track.kind === "video");
      if (sender) {
        sender.replaceTrack(screenTrack);
      }
      DOM.localVideo.srcObject = screenStream;

      screenTrack.onended = () => {
        if (sender && STATE.localStream && STATE.localStream.getVideoTracks()[0]) {
          sender.replaceTrack(STATE.localStream.getVideoTracks()[0]);
          DOM.localVideo.srcObject = STATE.localStream;
        }
      };
    } catch (e) {
      console.warn("Screen share annullato:", e);
    }
  });

  function startCallTimer() {
    clearInterval(STATE.callTimerInterval);
    STATE.callDurationSec = 0;
    STATE.callTimerInterval = setInterval(() => {
      STATE.callDurationSec++;
      const m = String(Math.floor(STATE.callDurationSec / 60)).padStart(2, "0");
      const s = String(STATE.callDurationSec % 60).padStart(2, "0");
      DOM.callTimer.textContent = `${m}:${s}`;
    }, 1000);
  }

  // Disconnetti Amico
  DOM.btnDisconnectPeer.addEventListener("click", () => {
    if (STATE.activeFriendId) {
      const conn = STATE.connections.get(STATE.activeFriendId);
      if (conn) conn.close();
      STATE.connections.delete(STATE.activeFriendId);
      showToast("Connessione P2P terminata.");
      selectFriendChat(STATE.activeFriendId);
    }
  });

  // --- MODALI AGGIUNTA AMICI & PROFILO ---
  function openAddFriendModal() {
    DOM.addFriendModal.style.display = "flex";
    setTimeout(() => DOM.inputFriendId.focus(), 100);
  }

  DOM.openAddModalMini.addEventListener("click", openAddFriendModal);
  DOM.guildAddFriendBtn.addEventListener("click", openAddFriendModal);
  DOM.btnWelcomeAddFriend.addEventListener("click", openAddFriendModal);

  DOM.btnCloseAddModal.addEventListener("click", () => DOM.addFriendModal.style.display = "none");
  DOM.btnCancelAddFriend.addEventListener("click", () => DOM.addFriendModal.style.display = "none");

  DOM.addFriendForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const friendId = DOM.inputFriendId.value.trim();
    let nick = DOM.inputFriendNickname.value.trim();
    if (!friendId) return;

    if (friendId === STATE.myPeerId) {
      showToast("Non puoi aggiungere il tuo stesso ID!");
      return;
    }

    if (nick && !nick.startsWith("@")) nick = "@" + nick;

    addOrUpdateFriend(friendId, nick);
    connectToPeer(friendId);
    selectFriendChat(friendId);

    DOM.inputFriendId.value = "";
    DOM.inputFriendNickname.value = "";
    DOM.addFriendModal.style.display = "none";
    showToast(`Amico aggiunto! Connessione in corso...`);
  });

  // Copia ID
  function copyMyPeerId() {
    if (!STATE.myPeerId) return;
    navigator.clipboard.writeText(STATE.myPeerId).then(() => {
      showToast(`WhytApp ID copiato negli appunti: ${STATE.myPeerId}`);
    });
  }
  DOM.copyMyIdBtn.addEventListener("click", copyMyPeerId);
  DOM.myIdContainer.addEventListener("click", copyMyPeerId);

  // Modifica Username
  DOM.btnSelfProfile.addEventListener("click", () => {
    DOM.inputUsername.value = STATE.myUsername.replace("@", "");
    DOM.onboardingModal.style.display = "flex";
    DOM.inputUsername.focus();
  });
  DOM.guildSettingsBtn.addEventListener("click", () => DOM.btnSelfProfile.click());

  // --- ONBOARDING FORM ---
  DOM.onboardingForm.addEventListener("submit", (e) => {
    e.preventDefault();
    let u = DOM.inputUsername.value.trim();
    if (!u) return;
    if (!u.startsWith("@")) u = "@" + u;

    STATE.myUsername = u;
    localStorage.setItem("whytapp_p2p_username", STATE.myUsername);
    DOM.onboardingModal.style.display = "none";

    DOM.myUsernameDisplay.textContent = STATE.myUsername;
    DOM.myAvatar.textContent = STATE.myUsername.replace("@", "").charAt(0).toUpperCase();

    initPeerClient();
  });

  // Inizializzazione Applicazione
  function startApp() {
    if (window.lucide) window.lucide.createIcons();
    loadFriendsFromStorage();

    if (!STATE.myUsername) {
      DOM.onboardingModal.style.display = "flex";
      setTimeout(() => DOM.inputUsername.focus(), 100);
    } else {
      DOM.myUsernameDisplay.textContent = STATE.myUsername;
      DOM.myAvatar.textContent = STATE.myUsername.replace("@", "").charAt(0).toUpperCase();
      initPeerClient();
    }
  }

  document.addEventListener("DOMContentLoaded", startApp);
})();
