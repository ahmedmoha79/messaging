class MessageEncryptor {
  constructor(supabaseClient, userId) {
    this.supabase = supabaseClient;
    this.userId = userId;
    this.keyStorageKey = `encryptionKeys_${userId}`;
    this.peerPublicKeys = new Map();
    this.algorithm = { 
      name: "ECDH", 
      namedCurve: "P-384" 
    };
    this.encryptionAlgo = {
      name: "AES-GCM",
      length: 256
    };

    // Initialize keys and setup listeners
    this.init();
  }

  async init() {
    try {
      await this.loadKeys();
      await this.setupKeyExchange();
      this.setupRealtimeListener();
    } catch (error) {
      console.error("[Encryptor] Initialization failed:", error);
    }
  }

  // ==================== KEY MANAGEMENT ==================== //
  async generateKeyPair() {
    try {
      const keyPair = await window.crypto.subtle.generateKey(
        this.algorithm,
        true,
        ["deriveKey", "deriveBits"]
      );

      const publicKey = await window.crypto.subtle.exportKey("jwk", keyPair.publicKey);
      const privateKey = await window.crypto.subtle.exportKey("jwk", keyPair.privateKey);

      // Add key ID for tracking
      publicKey.kid = `key_${this.userId}_${Date.now()}`;
      privateKey.kid = publicKey.kid;

      return { publicKey, privateKey };
    } catch (error) {
      console.error("[Encryptor] Key generation failed:", error);
      throw error;
    }
  }

  async loadKeys() {
    try {
      // Check for existing keys in localStorage
      const storedKeys = localStorage.getItem(this.keyStorageKey);
      if (storedKeys) {
        this.keys = JSON.parse(storedKeys);
        
        // Verify keys are valid
        try {
          await window.crypto.subtle.importKey(
            "jwk",
            this.keys.publicKey,
            this.algorithm,
            true,
            []
          );
          return;
        } catch (e) {
          console.warn("[Encryptor] Existing keys invalid, generating new ones");
        }
      }

      // Generate new keys if none exist or they're invalid
      this.keys = await this.generateKeyPair();
      localStorage.setItem(this.keyStorageKey, JSON.stringify(this.keys));
      
      // Store public key in database
      await this.storePublicKey();
    } catch (error) {
      console.error("[Encryptor] Key loading failed:", error);
      throw error;
    }
  }

  async storePublicKey() {
    try {
      const { error } = await this.supabase
        .from('user_keys')
        .upsert({
          user_id: this.userId,
          public_key: this.keys.publicKey,
          last_updated: new Date().toISOString()
        });
      
      if (error) throw error;
    } catch (error) {
      console.error("[Encryptor] Failed to store public key:", error);
    }
  }

  // ==================== ENCRYPTION/DECRYPTION ==================== //
  async encryptMessage(message, recipientId) {
    try {
      // Get recipient's public key (from cache or database)
      let recipientPublicKey = this.peerPublicKeys.get(recipientId);
      if (!recipientPublicKey) {
        recipientPublicKey = await this.fetchPublicKey(recipientId);
        if (!recipientPublicKey) {
          throw new Error("Recipient public key not found");
        }
        this.peerPublicKeys.set(recipientId, recipientPublicKey);
      }

      // Derive shared secret
      const sharedKey = await this.deriveSharedSecret(recipientPublicKey);

      // Encrypt message
      const iv = window.crypto.getRandomValues(new Uint8Array(12));
      const encodedMessage = new TextEncoder().encode(message);

      const ciphertext = await window.crypto.subtle.encrypt(
        { 
          name: "AES-GCM",
          iv: iv
        },
        sharedKey,
        encodedMessage
      );

      return {
        ciphertext: Array.from(new Uint8Array(ciphertext)),
        iv: Array.from(iv),
        sender: this.userId,
        keyId: this.keys.publicKey.kid,
        isEncrypted: true
      };
    } catch (error) {
      console.error("[Encryptor] Encryption failed:", error);
      throw error;
    }
  }

  async decryptMessage(encryptedData) {
    try {
      if (!encryptedData.isEncrypted) {
        return encryptedData.content; // Not encrypted
      }

      // Get sender's public key
      let senderPublicKey = this.peerPublicKeys.get(encryptedData.sender);
      if (!senderPublicKey) {
        senderPublicKey = await this.fetchPublicKey(encryptedData.sender);
        if (!senderPublicKey) {
          throw new Error("Sender public key not found");
        }
        this.peerPublicKeys.set(encryptedData.sender, senderPublicKey);
      }

      // Derive shared secret
      const sharedKey = await this.deriveSharedSecret(senderPublicKey);

      // Decrypt message
      const iv = new Uint8Array(encryptedData.iv);
      const ciphertext = new Uint8Array(encryptedData.ciphertext);

      const decrypted = await window.crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv: iv
        },
        sharedKey,
        ciphertext
      );

      return new TextDecoder().decode(decrypted);
    } catch (error) {
      console.error("[Encryptor] Decryption failed:", error);
      throw error;
    }
  }

  // ==================== KEY EXCHANGE ==================== //
  async fetchPublicKey(userId) {
    try {
      // Check cache first
      if (this.peerPublicKeys.has(userId)) {
        return this.peerPublicKeys.get(userId);
      }

      // Fetch from database
      const { data, error } = await this.supabase
        .from('user_keys')
        .select('public_key')
        .eq('user_id', userId)
        .single();

      if (error || !data) {
        throw new Error("Public key not found in database");
      }

      return data.public_key;
    } catch (error) {
      console.error(`[Encryptor] Failed to fetch public key for ${userId}:`, error);
      return null;
    }
  }

  async setupKeyExchange() {
    try {
      // Fetch public keys for all existing users
      const { data: users, error } = await this.supabase
        .from('users')
        .select('id')
        .neq('id', this.userId);

      if (error) throw error;

      // Pre-fetch public keys for all users
      await Promise.all(users.map(async (user) => {
        try {
          const key = await this.fetchPublicKey(user.id);
          if (key) {
            this.peerPublicKeys.set(user.id, key);
          }
        } catch (e) {
          console.warn(`[Encryptor] Couldn't fetch key for ${user.id}:`, e);
        }
      }));
    } catch (error) {
      console.error("[Encryptor] Key exchange setup failed:", error);
    }
  }

  setupRealtimeListener() {
    // Listen for new public keys being added
    this.supabase.channel('key-updates')
      .on('postgres_changes', {
        event: 'INSERT',
        schema: 'public',
        table: 'user_keys'
      }, (payload) => {
        if (payload.new.user_id !== this.userId) {
          this.peerPublicKeys.set(payload.new.user_id, payload.new.public_key);
          console.log(`[Encryptor] Updated public key for ${payload.new.user_id}`);
        }
      })
      .subscribe();
  }

  // ==================== INTERNAL METHODS ==================== //
  async deriveSharedSecret(peerPublicKeyJwk) {
    try {
      const peerPublicKey = await window.crypto.subtle.importKey(
        "jwk",
        peerPublicKeyJwk,
        this.algorithm,
        true,
        []
      );

      const privateKey = await window.crypto.subtle.importKey(
        "jwk",
        this.keys.privateKey,
        this.algorithm,
        true,
        ["deriveKey", "deriveBits"]
      );

      return await window.crypto.subtle.deriveKey(
        {
          name: "ECDH",
          public: peerPublicKey
        },
        privateKey,
        this.encryptionAlgo,
        true,
        ["encrypt", "decrypt"]
      );
    } catch (error) {
      console.error("[Encryptor] Key derivation failed:", error);
      throw error;
    }
  }
}

// ==================== INTEGRATION WITH EXISTING SYSTEM ==================== //
document.addEventListener("DOMContentLoaded", async () => {
  // Wait for Supabase client and user ID to be available
  const initEncryptor = () => {
    if (window.supabaseClient && window.currentUserId) {
      // Initialize encryptor
      window.messageEncryptor = new MessageEncryptor(window.supabaseClient, window.currentUserId);

      // Patch the sendMessage function to handle encryption
      const originalSend = window.sendMessage;
      window.sendMessage = async (receiverId, content, audioData = null) => {
        try {
          // Handle audio messages separately (they're already encrypted by the recorder)
          if (audioData) {
            return originalSend(receiverId, null, audioData);
          }

          // Encrypt text messages
          const encrypted = await window.messageEncryptor.encryptMessage(content, receiverId);
          return originalSend(receiverId, encrypted);
        } catch (error) {
          console.error("Failed to encrypt, sending raw:", error);
          return originalSend(receiverId, { content, isEncrypted: false });
        }
      };

      // Patch message handling to decrypt incoming messages
      window.handleIncomingMessage = async (message) => {
        try {
          if (message.isEncrypted) {
            message.content = await window.messageEncryptor.decryptMessage(message);
          }
          // Original message handling continues...
        } catch (error) {
          console.error("Decryption failed:", error);
        }
      };
    } else {
      setTimeout(initEncryptor, 500);
    }
  };

  initEncryptor();
});