// Create a dedicated table for user preferences in your Supabase database
/*
-- First create the table if it doesn't exist
CREATE TABLE IF NOT EXISTS user_chat_preferences (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID REFERENCES auth.users NOT NULL,
  bubble_style_sent JSONB DEFAULT '{"color":"#00ff88","gradient":{"from":"#00ff88","to":"#00ccff"},"shape":"rounded","shadow":true,"border":false,"borderColor":"#ffffff","borderWidth":1}',
  bubble_style_received JSONB DEFAULT '{"color":"#1e1e1e","gradient":null,"shape":"rounded","shadow":true,"border":false,"borderColor":"#ffffff","borderWidth":1}',
  chat_background JSONB DEFAULT '{"type":"color","value":"#121212","image_url":null,"blur":0,"opacity":1}',
  message_animation VARCHAR DEFAULT 'slide-up',
  font_family VARCHAR DEFAULT 'system-ui',
  read_receipt_style VARCHAR DEFAULT 'checkmark',
  typing_indicator_style VARCHAR DEFAULT 'dots',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Enable Row Level Security
ALTER TABLE user_chat_preferences ENABLE ROW LEVEL SECURITY;

-- Drop existing policies if they exist
DROP POLICY IF EXISTS "Users can read their own preferences" ON user_chat_preferences;
DROP POLICY IF EXISTS "Users can insert their own preferences" ON user_chat_preferences;
DROP POLICY IF EXISTS "Users can update their own preferences" ON user_chat_preferences;
DROP POLICY IF EXISTS "Users can delete their own preferences" ON user_chat_preferences;

-- Create policies
-- Allow users to read their own preferences
CREATE POLICY "Users can read their own preferences"
ON user_chat_preferences
FOR SELECT
USING (auth.uid() = user_id);

-- Allow users to insert their own preferences
CREATE POLICY "Users can insert their own preferences"
ON user_chat_preferences
FOR INSERT
WITH CHECK (auth.uid() = user_id);

-- Allow users to update their own preferences
CREATE POLICY "Users can update their own preferences"
ON user_chat_preferences
FOR UPDATE
USING (auth.uid() = user_id)
WITH CHECK (auth.uid() = user_id);

-- Allow users to delete their own preferences
CREATE POLICY "Users can delete their own preferences"
ON user_chat_preferences
FOR DELETE
USING (auth.uid() = user_id);

-- Create index for faster lookups
CREATE INDEX IF NOT EXISTS idx_user_chat_preferences_user_id ON user_chat_preferences(user_id);
*/

class ChatCustomizer {
  constructor(supabaseClient, currentUserId) {
    if (!supabaseClient || !currentUserId) {
      throw new Error('Supabase client and user ID are required');
    }
    this.supabase = supabaseClient;
    this.userId = currentUserId;
    this.defaultPreferences = this.getDefaultPreferences();
    this.currentPreferences = {...this.defaultPreferences};
    this.isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
    this.availableFonts = [
      'system-ui', 
      'Inter', 
      'Roboto', 
      'Open Sans', 
      'Montserrat', 
      'Poppins', 
      'Fira Code',
      'SF Pro Display',
      'Segoe UI'
    ];
    this.animationPresets = {
      'slide-up': 'messageAppear',
      'fade-in': 'fadeIn',
      'bounce': 'bounceIn',
      'scale': 'scaleIn',
      'flip': 'flipInY'
    };
    this.init();
  }

  async init() {
    try {
      // First ensure the style element exists
      this.injectCustomStyles();
      
      // Then load preferences
      await this.loadUserPreferences();
      
      // Apply preferences after styles are injected
      this.applyPreferences();
      
      // Load fonts last
      await this.loadFonts();
      
      // Add a mutation observer to ensure styles persist
      this.observeStyleChanges();
    } catch (error) {
      console.error('Error initializing chat customizer:', error);
      // Use default preferences on error
      this.currentPreferences = {...this.defaultPreferences};
      this.applyPreferences();
    }
  }

  async loadUserPreferences() {
    try {
      const { data, error } = await this.supabase
        .from('user_chat_preferences')
        .select('*')
        .eq('user_id', this.userId)
        .single()
        .throwOnError();  // This will throw an error if the response is not 200

      if (error) {
        console.error('Error loading preferences:', error);
        // If no preferences exist, create them
        await this.savePreferences(this.defaultPreferences);
        return;
      }

      if (data) {
        this.currentPreferences = {
          ...this.defaultPreferences,
          ...data,
          bubble_style_sent: {
            ...this.defaultPreferences.bubble_style_sent,
            ...(data.bubble_style_sent || {})
          },
          bubble_style_received: {
            ...this.defaultPreferences.bubble_style_received,
            ...(data.bubble_style_received || {})
          },
          chat_background: {
            ...this.defaultPreferences.chat_background,
            ...(data.chat_background || {})
          }
        };
      }
    } catch (error) {
      console.error('Error loading preferences:', error);
      this.currentPreferences = {...this.defaultPreferences};
    }
  }

  getDefaultPreferences() {
    return {
      bubble_style_sent: {
        color: '#00ff88',
        gradient: { from: '#00ff88', to: '#00ccff' },
        shape: 'rounded',
        shadow: true,
        border: false,
        borderColor: '#ffffff',
        borderWidth: 1,
        textColor: '#000000'
      },
      bubble_style_received: {
        color: '#1e1e1e',
        gradient: null,
        shape: 'rounded',
        shadow: true,
        border: false,
        borderColor: '#ffffff',
        borderWidth: 1,
        textColor: '#ffffff'
      },
      chat_background: {
        type: 'color',
        value: '#121212',
        image_url: null,
        blur: 0,
        opacity: 1,
        pattern: null
      },
      message_animation: 'slide-up',
      font_family: 'system-ui',
      read_receipt_style: 'checkmark',
      typing_indicator_style: 'dots',
      message_padding: this.isMobile ? '12px 16px' : '14px 18px',
      message_margin: this.isMobile ? '4px 0' : '6px 0',
      bubble_max_width: this.isMobile ? '85%' : '75%'
    };
  }

  async savePreferences(preferences) {
    try {
      // Format the data properly
      const dataToSave = {
        user_id: this.userId,
        bubble_style_sent: preferences.bubble_style_sent,
        bubble_style_received: preferences.bubble_style_received,
        chat_background: preferences.chat_background,
        message_animation: preferences.message_animation,
        font_family: preferences.font_family,
        read_receipt_style: preferences.read_receipt_style,
        typing_indicator_style: preferences.typing_indicator_style,
        updated_at: new Date().toISOString()
      };

      const { data, error } = await this.supabase
        .from('user_chat_preferences')
        .upsert(dataToSave, { 
          onConflict: 'user_id',
          returning: 'minimal',  // This tells Supabase to return minimal data
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json'  // This tells the server we want JSON response
          }
        });

      if (error) {
        console.error('Error saving preferences:', error);
        return false;
      }

      this.currentPreferences = {...this.currentPreferences, ...preferences};
      this.applyPreferences();
      return true;
    } catch (error) {
      console.error('Error saving preferences:', error);
      return false;
    }
  }

  applyPreferences() {
    // Apply bubble styles
    this.updateBubbleStyles();
    
    // Apply chat background
    this.updateChatBackground();
    
    // Apply font family
    this.updateFontFamily();
    
    // Apply animations
    this.updateMessageAnimations();
  }

  injectCustomStyles() {
    // Create a style element for dynamic styles if it doesn't exist
    let styleElement = document.getElementById('chat-customizer-styles');
    if (!styleElement) {
      styleElement = document.createElement('style');
      styleElement.id = 'chat-customizer-styles';
      document.head.appendChild(styleElement);
    }
    
    // Inject animation keyframes
    this.injectAnimations();
    
    // Apply current preferences immediately
    this.updateBubbleStyles();
    this.updateChatBackground();
    this.updateFontFamily();
  }

  injectAnimations() {
    const styleElement = document.getElementById('chat-customizer-styles');
    if (!styleElement) return;
    
    let css = '';
    
    // Add custom animations if not using defaults
    if (this.currentPreferences.message_animation !== 'slide-up') {
      switch (this.currentPreferences.message_animation) {
        case 'bounce':
          css += `
            @keyframes bounceIn {
              0%, 20%, 40%, 60%, 80%, 100% {animation-timing-function: cubic-bezier(0.215, 0.610, 0.355, 1.000);}
              0% {opacity: 0; transform: scale3d(.3, .3, .3);}
              20% {transform: scale3d(1.1, 1.1, 1.1);}
              40% {transform: scale3d(.9, .9, .9);}
              60% {opacity: 1; transform: scale3d(1.03, 1.03, 1.03);}
              80% {transform: scale3d(.97, .97, .97);}
              100% {opacity: 1; transform: scale3d(1, 1, 1);}
            }
          `;
          break;
          
        case 'scale':
          css += `
            @keyframes scaleIn {
              0% {opacity: 0; transform: scale(0.5);}
              100% {opacity: 1; transform: scale(1);}
            }
          `;
          break;
          
        case 'flip':
          css += `
            @keyframes flipInY {
              0% {transform: perspective(400px) rotateY(90deg); opacity: 0;}
              40% {transform: perspective(400px) rotateY(-10deg);}
              70% {transform: perspective(400px) rotateY(10deg);}
              100% {transform: perspective(400px) rotateY(0deg); opacity: 1;}
            }
          `;
          break;
      }
    }
    
    styleElement.innerHTML = css;
  }

  updateBubbleStyles() {
    const sentStyle = this.currentPreferences.bubble_style_sent;
    const receivedStyle = this.currentPreferences.bubble_style_received;
    
    const styleElement = document.getElementById('chat-customizer-styles');
    if (!styleElement) return;
    
    let css = styleElement.innerHTML;
    
    // Clear existing bubble styles
    css = css.replace(/\.message\.sent\s*{[^}]*}/g, '');
    css = css.replace(/\.message\.received\s*{[^}]*}/g, '');
    css = css.replace(/\.message\.sent \.message-content\s*{[^}]*}/g, '');
    css = css.replace(/\.message\.received \.message-content\s*{[^}]*}/g, '');
    
    // Generate new bubble styles
    const sentBubbleCSS = this.generateBubbleCSS(sentStyle, 'sent');
    const receivedBubbleCSS = this.generateBubbleCSS(receivedStyle, 'received');
    
    // Add general message styling
    css += `
      .message {
        display: flex;
        width: 100%;
        margin: ${this.currentPreferences.message_margin};
      }
      
      .message-content {
        animation: ${this.animationPresets[this.currentPreferences.message_animation]} 0.3s ease-out forwards;
      }
      
      ${sentBubbleCSS}
      ${receivedBubbleCSS}
    `;
    
    styleElement.innerHTML = css;
  }

  generateBubbleCSS(style, type) {
    let css = `
      .message.${type} {
        display: flex;
        justify-content: ${type === 'sent' ? 'flex-start' : 'flex-end'};
        width: 100%;
        margin: ${this.currentPreferences.message_margin};
      }

      .message.${type} .message-content {
        color: ${style.textColor || (type === 'sent' ? '#000000' : '#ffffff')};
        ${style.gradient ? 
          `background: linear-gradient(135deg, ${style.gradient.from}, ${style.gradient.to});` : 
          `background: ${style.color};`
        }
        ${style.shadow ? 'box-shadow: 0 2px 8px rgba(0, 0, 0, 0.2);' : ''}
        ${style.border ? `border: ${style.borderWidth}px solid ${style.borderColor};` : ''}
        max-width: ${this.currentPreferences.bubble_max_width};
        padding: ${this.currentPreferences.message_padding};
    `;
    
    // Handle bubble shape
    switch (style.shape) {
      case 'rounded':
        css += 'border-radius: var(--radius-md);';
        css += type === 'sent' ? 
          'border-bottom-right-radius: 4px;' : 
          'border-bottom-left-radius: 4px;';
        break;
      case 'square':
        css += 'border-radius: 0;';
        break;
      case 'round':
        css += 'border-radius: 24px;';
        break;
      case 'custom':
        css += `
          border-radius: 8px 24px 24px 8px;
          ${type === 'sent' ? 'border-radius: 24px 8px 8px 24px;' : ''}
        `;
        break;
    }
    
    css += '}';
    
    return css;
  }

  updateChatBackground() {
    const background = this.currentPreferences.chat_background;
    const chatView = document.getElementById('chatView');
    const messagesContainer = document.getElementById('chatMessages');
    
    if (!chatView || !messagesContainer) return;
    
    let backgroundCSS = '';
    
    switch (background.type) {
      case 'color':
        backgroundCSS = `background: ${background.value};`;
        break;
      case 'gradient':
        backgroundCSS = `background: linear-gradient(135deg, ${background.value.from}, ${background.value.to});`;
        break;
      case 'image':
        backgroundCSS = `
          background: url('${background.image_url}') center/cover no-repeat;
          ${background.blur > 0 ? `backdrop-filter: blur(${background.blur}px);` : ''}
          opacity: ${background.opacity};
        `;
        break;
      case 'pattern':
        backgroundCSS = this.generatePatternCSS(background.pattern);
        break;
    }
    
    messagesContainer.style.cssText = backgroundCSS;
    
    // Add overlay for better readability if needed
    if (background.type !== 'color' && background.type !== 'gradient') {
      if (!document.getElementById('chat-background-overlay')) {
        const overlay = document.createElement('div');
        overlay.id = 'chat-background-overlay';
        overlay.style.position = 'absolute';
        overlay.style.top = '0';
        overlay.style.left = '0';
        overlay.style.right = '0';
        overlay.style.bottom = '0';
        overlay.style.backgroundColor = 'rgba(0, 0, 0, 0.5)';
        overlay.style.zIndex = '-1';
        messagesContainer.appendChild(overlay);
      }
    } else {
      const overlay = document.getElementById('chat-background-overlay');
      if (overlay) overlay.remove();
    }
  }

  generatePatternCSS(pattern) {
    // Implement various CSS patterns
    // This is a simplified version - you could expand with many more patterns
    switch (pattern) {
      case 'grid':
        return `
          background-color: #121212;
          background-image: 
            linear-gradient(rgba(255, 255, 255, 0.1) 1px, transparent 1px),
            linear-gradient(90deg, rgba(255, 255, 255, 0.1) 1px, transparent 1px);
          background-size: 20px 20px;
        `;
      case 'dots':
        return `
          background-color: #121212;
          background-image: radial-gradient(rgba(255, 255, 255, 0.1) 1px, transparent 1px);
          background-size: 15px 15px;
        `;
      case 'lines':
        return `
          background-color: #121212;
          background-image: repeating-linear-gradient(
            0deg,
            rgba(255, 255, 255, 0.1),
            rgba(255, 255, 255, 0.1) 1px,
            transparent 1px,
            transparent 20px
          );
        `;
      default:
        return `background: #121212;`;
    }
  }

  updateFontFamily() {
    document.documentElement.style.setProperty(
      '--font-family', 
      this.currentPreferences.font_family === 'system-ui' ? 
        '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Oxygen, Ubuntu, Cantarell, sans-serif' : 
        this.currentPreferences.font_family
    );
    
    // Apply to all messages
    const messages = document.querySelectorAll('.message-content');
    messages.forEach(msg => {
      msg.style.fontFamily = this.currentPreferences.font_family === 'system-ui' ? 
        'var(--font-family)' : 
        this.currentPreferences.font_family;
    });
  }

  updateMessageAnimations() {
    const messages = document.querySelectorAll('.message');
    messages.forEach(msg => {
      msg.style.animationName = this.animationPresets[this.currentPreferences.message_animation];
    });
  }

  async loadFonts() {
    // Load custom fonts if not system font
    if (this.currentPreferences.font_family !== 'system-ui' && 
        !this.availableFonts.includes(this.currentPreferences.font_family)) {
      try {
        // Use FontFace API to load custom fonts
        const font = new FontFace(
          this.currentPreferences.font_family,
          `url('fonts/${this.currentPreferences.font_family}.woff2') format('woff2')`
        );
        
        await font.load();
        document.fonts.add(font);
      } catch (error) {
        console.error('Failed to load font:', error);
        // Fallback to system font
        this.currentPreferences.font_family = 'system-ui';
        this.updateFontFamily();
      }
    }
  }

  // UI Methods for the customization panel
  async showCustomizationPanel() {
    // Create or show the customization panel
    let panel = document.getElementById('customization-panel');
    if (!panel) {
      await this.createCustomizationPanel();
      panel = document.getElementById('customization-panel');
    }
    if (panel) {
      panel.style.display = 'block';
    }
  }

  async createCustomizationPanel() {
    // Create the panel element
    const panel = document.createElement('div');
    panel.id = 'customization-panel';
    
    // Set initial styles
    Object.assign(panel.style, {
        position: 'fixed',
        top: '0',
        left: '0',
        right: '0',
        bottom: '0',
        background: 'rgba(0, 0, 0, 0.9)',
        zIndex: '2000',
        backdropFilter: 'blur(10px)',
        overflowY: 'auto',
        padding: '20px',
        display: 'flex',
        flexDirection: 'column'
    });
    
    // Close button
    const closeButton = document.createElement('button');
    closeButton.innerHTML = '<i class="fas fa-times"></i>';
    Object.assign(closeButton.style, {
        position: 'absolute',
        top: '20px',
        right: '20px',
        background: 'none',
        border: 'none',
        color: 'white',
        fontSize: '24px',
        cursor: 'pointer'
    });
    closeButton.addEventListener('click', () => {
        panel.style.display = 'none';
    });
    panel.appendChild(closeButton);
    
    // Title
    const title = document.createElement('h2');
    title.textContent = 'Chat Customization';
    Object.assign(title.style, {
        color: 'var(--primary)',
        marginBottom: '30px',
        fontSize: '24px'
    });
    panel.appendChild(title);
    
    // Create tabs for different customization sections
    const tabs = ['Bubbles', 'Background', 'Fonts', 'Animations', 'Advanced'];
    const tabContainer = document.createElement('div');
    Object.assign(tabContainer.style, {
        display: 'flex',
        marginBottom: '20px',
        borderBottom: '1px solid var(--border)'
    });
    
    // Create tab contents first
    const contentContainer = document.createElement('div');
    Object.assign(contentContainer.style, {
        flex: '1',
        overflowY: 'auto'
    });
    
    // Bubbles tab
    const bubblesTab = this.createBubblesCustomizationTab();
    bubblesTab.id = 'tab-0';
    bubblesTab.style.display = 'block';
    contentContainer.appendChild(bubblesTab);
    
    // Background tab
    const backgroundTab = this.createBackgroundCustomizationTab();
    backgroundTab.id = 'tab-1';
    backgroundTab.style.display = 'none';
    contentContainer.appendChild(backgroundTab);
    
    // Fonts tab
    const fontsTab = this.createFontsCustomizationTab();
    fontsTab.id = 'tab-2';
    fontsTab.style.display = 'none';
    contentContainer.appendChild(fontsTab);
    
    // Animations tab
    const animationsTab = this.createAnimationsCustomizationTab();
    animationsTab.id = 'tab-3';
    animationsTab.style.display = 'none';
    contentContainer.appendChild(animationsTab);
    
    // Advanced tab
    const advancedTab = this.createAdvancedCustomizationTab();
    advancedTab.id = 'tab-4';
    advancedTab.style.display = 'none';
    contentContainer.appendChild(advancedTab);
    
    // Create tabs after content is ready
    tabs.forEach((tab, index) => {
        const tabElement = document.createElement('div');
        tabElement.textContent = tab;
        Object.assign(tabElement.style, {
            padding: '10px 20px',
            cursor: 'pointer',
            borderBottom: '2px solid transparent',
            marginRight: '10px',
            fontWeight: '500'
        });
        tabElement.addEventListener('click', () => {
            // Switch tab content
            document.querySelectorAll('.tab-content').forEach(content => {
                content.style.display = 'none';
            });
            document.getElementById(`tab-${index}`).style.display = 'block';
            
            // Update active tab style
            document.querySelectorAll('.customization-tab').forEach(t => {
                t.style.borderBottomColor = 'transparent';
                t.style.color = 'var(--text-secondary)';
            });
            tabElement.style.borderBottomColor = 'var(--primary)';
            tabElement.style.color = 'var(--primary)';
        });
        tabElement.className = 'customization-tab';
        tabContainer.appendChild(tabElement);
    });
    
    panel.appendChild(tabContainer);
    panel.appendChild(contentContainer);
    
    // Set first tab as active
    const firstTab = document.querySelector('.customization-tab');
    if (firstTab) {
        firstTab.style.borderBottomColor = 'var(--primary)';
        firstTab.style.color = 'var(--primary)';
    }
    
    // Add save button
    const saveButton = document.createElement('button');
    saveButton.textContent = 'Save Changes';
    Object.assign(saveButton.style, {
        background: 'var(--primary)',
        color: 'black',
        border: 'none',
        padding: '12px 24px',
        borderRadius: 'var(--radius-md)',
        fontWeight: '600',
        marginTop: '20px',
        alignSelf: 'flex-end',
        cursor: 'pointer'
    });
    saveButton.addEventListener('click', async () => {
        await this.savePreferences(this.currentPreferences);
        panel.style.display = 'none';
    });
    panel.appendChild(saveButton);
    
    // Add the panel to the document
    document.body.appendChild(panel);
  }

  createBubblesCustomizationTab() {
    const tab = document.createElement('div');
    tab.className = 'tab-content';
    
    // Sent messages section
    const sentSection = document.createElement('div');
    sentSection.innerHTML = `
      <h3 style="color: var(--text-primary); margin-bottom: 15px;">Sent Messages</h3>
    `;
    
    // Color picker for sent messages
    const sentColorLabel = document.createElement('label');
    sentColorLabel.textContent = 'Bubble Color';
    sentColorLabel.style.display = 'block';
    sentColorLabel.style.marginBottom = '8px';
    sentColorLabel.style.color = 'var(--text-secondary)';
    
    const sentColorInput = document.createElement('input');
    sentColorInput.type = 'color';
    sentColorInput.value = this.currentPreferences.bubble_style_sent.color;
    sentColorInput.style.marginBottom = '15px';
    sentColorInput.addEventListener('input', (e) => {
      this.currentPreferences.bubble_style_sent.color = e.target.value;
      this.currentPreferences.bubble_style_sent.gradient = null;
      this.updateBubbleStyles();
    });
    
    // Gradient toggle
    const gradientLabel = document.createElement('label');
    gradientLabel.textContent = 'Use Gradient';
    gradientLabel.style.display = 'block';
    gradientLabel.style.marginBottom = '8px';
    gradientLabel.style.color = 'var(--text-secondary)';
    
    const gradientToggle = document.createElement('input');
    gradientToggle.type = 'checkbox';
    gradientToggle.checked = !!this.currentPreferences.bubble_style_sent.gradient;
    gradientToggle.style.marginBottom = '15px';
    gradientToggle.addEventListener('change', (e) => {
      if (e.target.checked) {
        this.currentPreferences.bubble_style_sent.gradient = {
          from: this.currentPreferences.bubble_style_sent.color,
          to: '#00ccff'
        };
      } else {
        this.currentPreferences.bubble_style_sent.gradient = null;
      }
      this.updateBubbleStyles();
    });
    
    // Gradient color pickers (only show if gradient is enabled)
    const gradientFromContainer = document.createElement('div');
    gradientFromContainer.style.display = gradientToggle.checked ? 'block' : 'none';
    gradientFromContainer.style.marginBottom = '15px';
    
    const gradientFromLabel = document.createElement('label');
    gradientFromLabel.textContent = 'Gradient Start Color';
    gradientFromLabel.style.display = 'block';
    gradientFromLabel.style.marginBottom = '8px';
    gradientFromLabel.style.color = 'var(--text-secondary)';
    
    const gradientFromInput = document.createElement('input');
    gradientFromInput.type = 'color';
    gradientFromInput.value = this.currentPreferences.bubble_style_sent.gradient?.from || this.currentPreferences.bubble_style_sent.color;
    gradientFromInput.addEventListener('input', (e) => {
      if (this.currentPreferences.bubble_style_sent.gradient) {
        this.currentPreferences.bubble_style_sent.gradient.from = e.target.value;
        this.updateBubbleStyles();
      }
    });
    
    const gradientToLabel = document.createElement('label');
    gradientToLabel.textContent = 'Gradient End Color';
    gradientToLabel.style.display = 'block';
    gradientToLabel.style.marginBottom = '8px';
    gradientToLabel.style.color = 'var(--text-secondary)';
    
    const gradientToInput = document.createElement('input');
    gradientToInput.type = 'color';
    gradientToInput.value = this.currentPreferences.bubble_style_sent.gradient?.to || '#00ccff';
    gradientToInput.addEventListener('input', (e) => {
      if (this.currentPreferences.bubble_style_sent.gradient) {
        this.currentPreferences.bubble_style_sent.gradient.to = e.target.value;
        this.updateBubbleStyles();
      }
    });
    
    gradientFromContainer.appendChild(gradientFromLabel);
    gradientFromContainer.appendChild(gradientFromInput);
    gradientFromContainer.appendChild(gradientToLabel);
    gradientFromContainer.appendChild(gradientToInput);
    
    // Show/hide gradient controls based on toggle
    gradientToggle.addEventListener('change', (e) => {
      gradientFromContainer.style.display = e.target.checked ? 'block' : 'none';
    });
    
    // Text color picker
    const textColorLabel = document.createElement('label');
    textColorLabel.textContent = 'Text Color';
    textColorLabel.style.display = 'block';
    textColorLabel.style.marginBottom = '8px';
    textColorLabel.style.color = 'var(--text-secondary)';
    
    const textColorInput = document.createElement('input');
    textColorInput.type = 'color';
    textColorInput.value = this.currentPreferences.bubble_style_sent.textColor || '#000000';
    textColorInput.style.marginBottom = '15px';
    textColorInput.addEventListener('input', (e) => {
      this.currentPreferences.bubble_style_sent.textColor = e.target.value;
      this.updateBubbleStyles();
    });
    
    // Bubble shape selector
    const shapeLabel = document.createElement('label');
    shapeLabel.textContent = 'Bubble Shape';
    shapeLabel.style.display = 'block';
    shapeLabel.style.marginBottom = '8px';
    shapeLabel.style.color = 'var(--text-secondary)';
    
    const shapeSelect = document.createElement('select');
    shapeSelect.style.marginBottom = '15px';
    shapeSelect.style.width = '100%';
    shapeSelect.style.padding = '8px';
    shapeSelect.style.borderRadius = 'var(--radius-sm)';
    shapeSelect.style.backgroundColor = 'var(--surface-light)';
    shapeSelect.style.color = 'var(--text-primary)';
    shapeSelect.style.border = '1px solid var(--border)';
    
    const shapes = [
      { value: 'rounded', label: 'Rounded' },
      { value: 'square', label: 'Square' },
      { value: 'round', label: 'Round' },
      { value: 'custom', label: 'Custom' }
    ];
    
    shapes.forEach(shape => {
      const option = document.createElement('option');
      option.value = shape.value;
      option.textContent = shape.label;
      option.selected = this.currentPreferences.bubble_style_sent.shape === shape.value;
      shapeSelect.appendChild(option);
    });
    
    shapeSelect.addEventListener('change', (e) => {
      this.currentPreferences.bubble_style_sent.shape = e.target.value;
      this.updateBubbleStyles();
    });
    
    // Shadow toggle
    const shadowLabel = document.createElement('label');
    shadowLabel.textContent = 'Shadow';
    shadowLabel.style.display = 'block';
    shadowLabel.style.marginBottom = '8px';
    shadowLabel.style.color = 'var(--text-secondary)';
    
    const shadowToggle = document.createElement('input');
    shadowToggle.type = 'checkbox';
    shadowToggle.checked = this.currentPreferences.bubble_style_sent.shadow;
    shadowToggle.style.marginBottom = '15px';
    shadowToggle.addEventListener('change', (e) => {
      this.currentPreferences.bubble_style_sent.shadow = e.target.checked;
      this.updateBubbleStyles();
    });
    
    // Border controls
    const borderLabel = document.createElement('label');
    borderLabel.textContent = 'Border';
    borderLabel.style.display = 'block';
    borderLabel.style.marginBottom = '8px';
    borderLabel.style.color = 'var(--text-secondary)';
    
    const borderToggle = document.createElement('input');
    borderToggle.type = 'checkbox';
    borderToggle.checked = this.currentPreferences.bubble_style_sent.border;
    borderToggle.style.marginBottom = '15px';
    borderToggle.addEventListener('change', (e) => {
      this.currentPreferences.bubble_style_sent.border = e.target.checked;
      this.updateBubbleStyles();
    });
    
    // Border color picker (only show if border is enabled)
    const borderColorContainer = document.createElement('div');
    borderColorContainer.style.display = borderToggle.checked ? 'block' : 'none';
    borderColorContainer.style.marginBottom = '15px';
    
    const borderColorLabel = document.createElement('label');
    borderColorLabel.textContent = 'Border Color';
    borderColorLabel.style.display = 'block';
    borderColorLabel.style.marginBottom = '8px';
    borderColorLabel.style.color = 'var(--text-secondary)';
    
    const borderColorInput = document.createElement('input');
    borderColorInput.type = 'color';
    borderColorInput.value = this.currentPreferences.bubble_style_sent.borderColor || '#ffffff';
    borderColorInput.addEventListener('input', (e) => {
      this.currentPreferences.bubble_style_sent.borderColor = e.target.value;
      this.updateBubbleStyles();
    });
    
    // Border width slider
    const borderWidthLabel = document.createElement('label');
    borderWidthLabel.textContent = 'Border Width';
    borderWidthLabel.style.display = 'block';
    borderWidthLabel.style.marginBottom = '8px';
    borderWidthLabel.style.color = 'var(--text-secondary)';
    
    const borderWidthInput = document.createElement('input');
    borderWidthInput.type = 'range';
    borderWidthInput.min = '1';
    borderWidthInput.max = '5';
    borderWidthInput.value = this.currentPreferences.bubble_style_sent.borderWidth || 1;
    borderWidthInput.style.width = '100%';
    borderWidthInput.style.marginBottom = '15px';
    borderWidthInput.addEventListener('input', (e) => {
      this.currentPreferences.bubble_style_sent.borderWidth = parseInt(e.target.value);
      this.updateBubbleStyles();
    });
    
    borderColorContainer.appendChild(borderColorLabel);
    borderColorContainer.appendChild(borderColorInput);
    borderColorContainer.appendChild(borderWidthLabel);
    borderColorContainer.appendChild(borderWidthInput);
    
    // Show/hide border controls based on toggle
    borderToggle.addEventListener('change', (e) => {
      borderColorContainer.style.display = e.target.checked ? 'block' : 'none';
    });
    
    // Add all controls to sent section
    sentSection.appendChild(sentColorLabel);
    sentSection.appendChild(sentColorInput);
    sentSection.appendChild(gradientLabel);
    sentSection.appendChild(gradientToggle);
    sentSection.appendChild(gradientFromContainer);
    sentSection.appendChild(textColorLabel);
    sentSection.appendChild(textColorInput);
    sentSection.appendChild(shapeLabel);
    sentSection.appendChild(shapeSelect);
    sentSection.appendChild(shadowLabel);
    sentSection.appendChild(shadowToggle);
    sentSection.appendChild(borderLabel);
    sentSection.appendChild(borderToggle);
    sentSection.appendChild(borderColorContainer);
    
    // Received messages section (similar to sent but with different defaults)
    const receivedSection = document.createElement('div');
    receivedSection.innerHTML = `
      <h3 style="color: var(--text-primary); margin-top: 30px; margin-bottom: 15px;">Received Messages</h3>
    `;
    
    // Add similar controls for received messages...
    // (Implementation would be similar to sent messages section)
    
    tab.appendChild(sentSection);
    tab.appendChild(receivedSection);
    
    return tab;
  }

  createBackgroundCustomizationTab() {
    const tab = document.createElement('div');
    tab.className = 'tab-content';
    
    // Background type selector
    const typeLabel = document.createElement('label');
    typeLabel.textContent = 'Background Type';
    typeLabel.style.display = 'block';
    typeLabel.style.marginBottom = '8px';
    typeLabel.style.color = 'var(--text-secondary)';
    
    const typeSelect = document.createElement('select');
    typeSelect.style.marginBottom = '15px';
    typeSelect.style.width = '100%';
    typeSelect.style.padding = '8px';
    typeSelect.style.borderRadius = 'var(--radius-sm)';
    typeSelect.style.backgroundColor = 'var(--surface-light)';
    typeSelect.style.color = 'var(--text-primary)';
    typeSelect.style.border = '1px solid var(--border)';
    
    const types = [
      { value: 'color', label: 'Solid Color' },
      { value: 'gradient', label: 'Gradient' },
      { value: 'image', label: 'Image' },
      { value: 'pattern', label: 'Pattern' }
    ];
    
    types.forEach(type => {
      const option = document.createElement('option');
      option.value = type.value;
      option.textContent = type.label;
      option.selected = this.currentPreferences.chat_background.type === type.value;
      typeSelect.appendChild(option);
    });
    
    typeSelect.addEventListener('change', (e) => {
      this.currentPreferences.chat_background.type = e.target.value;
      this.updateChatBackground();
      // Show/hide appropriate controls based on selection
    });
    
    // Add controls for each background type
    // (Implementation would include color pickers, image upload, pattern selectors, etc.)
    
    tab.appendChild(typeLabel);
    tab.appendChild(typeSelect);
    
    return tab;
  }

  createFontsCustomizationTab() {
    const tab = document.createElement('div');
    tab.className = 'tab-content';
    
    // Font family selector
    const fontLabel = document.createElement('label');
    fontLabel.textContent = 'Font Family';
    fontLabel.style.display = 'block';
    fontLabel.style.marginBottom = '8px';
    fontLabel.style.color = 'var(--text-secondary)';
    
    const fontSelect = document.createElement('select');
    fontSelect.style.marginBottom = '15px';
    fontSelect.style.width = '100%';
    fontSelect.style.padding = '8px';
    fontSelect.style.borderRadius = 'var(--radius-sm)';
    fontSelect.style.backgroundColor = 'var(--surface-light)';
    fontSelect.style.color = 'var(--text-primary)';
    fontSelect.style.border = '1px solid var(--border)';
    
    this.availableFonts.forEach(font => {
      const option = document.createElement('option');
      option.value = font;
      option.textContent = font;
      option.selected = this.currentPreferences.font_family === font;
      option.style.fontFamily = font === 'system-ui' ? 'var(--font-family)' : font;
      fontSelect.appendChild(option);
    });
    
    fontSelect.addEventListener('change', (e) => {
      this.currentPreferences.font_family = e.target.value;
      this.updateFontFamily();
    });
    
    tab.appendChild(fontLabel);
    tab.appendChild(fontSelect);
    
    return tab;
  }

  createAnimationsCustomizationTab() {
    const tab = document.createElement('div');
    tab.className = 'tab-content';
    
    // Animation selector
    const animationLabel = document.createElement('label');
    animationLabel.textContent = 'Message Animation';
    animationLabel.style.display = 'block';
    animationLabel.style.marginBottom = '8px';
    animationLabel.style.color = 'var(--text-secondary)';
    
    const animationSelect = document.createElement('select');
    animationSelect.style.marginBottom = '15px';
    animationSelect.style.width = '100%';
    animationSelect.style.padding = '8px';
    animationSelect.style.borderRadius = 'var(--radius-sm)';
    animationSelect.style.backgroundColor = 'var(--surface-light)';
    animationSelect.style.color = 'var(--text-primary)';
    animationSelect.style.border = '1px solid var(--border)';
    
    Object.keys(this.animationPresets).forEach(key => {
      const option = document.createElement('option');
      option.value = key;
      option.textContent = key.charAt(0).toUpperCase() + key.slice(1).replace('-', ' ');
      option.selected = this.currentPreferences.message_animation === key;
      animationSelect.appendChild(option);
    });
    
    animationSelect.addEventListener('change', (e) => {
      this.currentPreferences.message_animation = e.target.value;
      this.injectAnimations();
      this.updateMessageAnimations();
    });
    
    tab.appendChild(animationLabel);
    tab.appendChild(animationSelect);
    
    return tab;
  }

  createAdvancedCustomizationTab() {
    const tab = document.createElement('div');
    tab.className = 'tab-content';
    
    // Advanced settings like message padding, margins, etc.
    const paddingLabel = document.createElement('label');
    paddingLabel.textContent = 'Message Padding';
    paddingLabel.style.display = 'block';
    paddingLabel.style.marginBottom = '8px';
    paddingLabel.style.color = 'var(--text-secondary)';
    
    const paddingInput = document.createElement('input');
    paddingInput.type = 'text';
    paddingInput.value = this.currentPreferences.message_padding;
    paddingInput.style.marginBottom = '15px';
    paddingInput.style.width = '100%';
    paddingInput.style.padding = '8px';
    paddingInput.style.borderRadius = 'var(--radius-sm)';
    paddingInput.style.backgroundColor = 'var(--surface-light)';
    paddingInput.style.color = 'var(--text-primary)';
    paddingInput.style.border = '1px solid var(--border)';
    paddingInput.addEventListener('change', (e) => {
      this.currentPreferences.message_padding = e.target.value;
      this.updateBubbleStyles();
    });
    
    // Max width selector
    const widthLabel = document.createElement('label');
    widthLabel.textContent = 'Max Bubble Width';
    widthLabel.style.display = 'block';
    widthLabel.style.marginBottom = '8px';
    widthLabel.style.color = 'var(--text-secondary)';
    
    const widthInput = document.createElement('input');
    widthInput.type = 'text';
    widthInput.value = this.currentPreferences.bubble_max_width;
    widthInput.style.marginBottom = '15px';
    widthInput.style.width = '100%';
    widthInput.style.padding = '8px';
    widthInput.style.borderRadius = 'var(--radius-sm)';
    widthInput.style.backgroundColor = 'var(--surface-light)';
    widthInput.style.color = 'var(--text-primary)';
    widthInput.style.border = '1px solid var(--border)';
    widthInput.addEventListener('change', (e) => {
      this.currentPreferences.bubble_max_width = e.target.value;
      this.updateBubbleStyles();
    });
    
    tab.appendChild(paddingLabel);
    tab.appendChild(paddingInput);
    tab.appendChild(widthLabel);
    tab.appendChild(widthInput);
    
    return tab;
  }

  // Utility method to apply styles to a new message
  styleNewMessage(messageElement, isSent) {
    const style = isSent ? 
      this.currentPreferences.bubble_style_sent : 
      this.currentPreferences.bubble_style_received;
    
    const contentElement = messageElement.querySelector('.message-content');
    if (!contentElement) return;
    
    contentElement.style.color = style.textColor || (isSent ? '#000000' : '#ffffff');
    
    if (style.gradient) {
      contentElement.style.background = `linear-gradient(135deg, ${style.gradient.from}, ${style.gradient.to})`;
    } else {
      contentElement.style.background = style.color;
    }
    
    contentElement.style.boxShadow = style.shadow ? '0 2px 8px rgba(0, 0, 0, 0.2)' : 'none';
    
    if (style.border) {
      contentElement.style.border = `${style.borderWidth}px solid ${style.borderColor}`;
    } else {
      contentElement.style.border = 'none';
    }
    
    // Apply shape
    switch (style.shape) {
      case 'rounded':
        contentElement.style.borderRadius = 'var(--radius-md)';
        contentElement.style[isSent ? 'borderBottomRightRadius' : 'borderBottomLeftRadius'] = '4px';
        break;
      case 'square':
        contentElement.style.borderRadius = '0';
        break;
      case 'round':
        contentElement.style.borderRadius = '24px';
        break;
      case 'custom':
        contentElement.style.borderRadius = isSent ? '24px 8px 8px 24px' : '8px 24px 24px 8px';
        break;
    }
    
    // Apply animation
    contentElement.style.animation = `${this.animationPresets[this.currentPreferences.message_animation]} 0.3s ease-out forwards`;
    
    // Apply font
    contentElement.style.fontFamily = this.currentPreferences.font_family === 'system-ui' ? 
      'var(--font-family)' : 
      this.currentPreferences.font_family;
  }

  observeStyleChanges() {
    // Create a mutation observer to watch for style changes
    const observer = new MutationObserver((mutations) => {
      mutations.forEach((mutation) => {
        if (mutation.type === 'childList' && mutation.removedNodes.length > 0) {
          // If our style element was removed, reinject it
          if (!document.getElementById('chat-customizer-styles')) {
            this.injectCustomStyles();
            this.applyPreferences();
          }
        }
      });
    });

    // Start observing the document head for changes
    observer.observe(document.head, {
      childList: true,
      subtree: true
    });
  }
}

// Export for module usage
if (typeof module !== 'undefined' && module.exports) {
  module.exports = ChatCustomizer;
}