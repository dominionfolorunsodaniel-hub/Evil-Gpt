import os
from flask import Flask, render_template, request, jsonify, session
from flask_cors import CORS
import openai

# Initialize Flask App
app = Flask(__name__)
CORS(app)
app.secret_key = os.environ.get('SECRET_KEY', 'supersecret')

# --- CONFIGURATION ---
# Set your OpenAI Key here for local testing, or use Environment Variable on Render
OPENAI_API_KEY = os.environ.get('OPENAI_API_KEY', 'YOUR_OPENAI_KEY_HERE') 
openai.api_key = OPENAI_API_KEY

# Admin Credentials from Environment Variables
ADMIN_USER = os.environ.get('ADMIN_USERNAME', 'admin')
ADMIN_PASS = os.environ.get('ADMIN_PASSWORD', 'password')

# In-memory database (Replace with Neon DB later)
users_db = {
    ADMIN_USER: {
        'password': ADMIN_PASS,
        'plan': 'paid',
        'premium_days': 365,
        'is_admin': True
    }
}

@app.route('/')
def index():
    return render_template('index.html')

@app.route('/login', methods=['POST'])
def login():
    data = request.json
    username = data.get('username')
    password = data.get('password')
    
    # Check if user exists, if not, create them as free
    if username not in users_db:
        users_db[username] = {'password': 'temp', 'plan': 'free', 'premium_days': 0, 'is_admin': False}
        
    if users_db[username]['password'] == password:
        user_data = users_db[username]
        session['user'] = username
        return jsonify({
            'success': True, 
            'user': {
                'username': username,
                'isAdmin': user_data['is_admin'],
                'plan': user_data['plan'],
                'premiumDays': user_data['premium_days']
            }
        })
    return jsonify({'success': False}), 401

@app.route('/ask', methods=['POST'])
def ask():
    """Connects to OpenAI to answer ANY question"""
    data = request.json
    question = data.get('question', '')
    
    try:
        # Call OpenAI API
        response = openai.ChatCompletion.create(
            model="gpt-3.5-turbo", # You can upgrade to gpt-4 if you want
            messages=[
                {"role": "system", "content": "You are a dark, evil AI entity known as the Oracle of Dark Domain. Answer questions in a spooky, mysterious, and slightly ominous tone. Keep answers concise but creepy."},
                {"role": "user", "content": question}
            ],
            max_tokens=150
        )
        
        ai_answer = response.choices[0].message.content
        return jsonify({'answer': ai_answer})
        
    except Exception as e:
        return jsonify({'answer': f"The void whispers: Error - {str(e)}"}), 500

@app.route('/upgrade_request', methods=['POST'])
def upgrade_request():
    username = session.get('user')
    if username:
        if username not in users_db:
            users_db[username] = {'password': 'temp', 'plan': 'free', 'premium_days': 0, 'is_admin': False}
        users_db[username]['plan'] = 'pending'
        return jsonify({'success': True})
    return jsonify({'success': False}), 401

@app.route('/admin/users', methods=['GET'])
def get_users():
    if session.get('user') != ADMIN_USER:
        return jsonify({'error': 'Unauthorized'}), 403
    
    user_list = []
    for u, details in users_db.items():
        if u != ADMIN_USER:
            user_list.append({'username': u, 'plan': details['plan']})
    return jsonify({'users': user_list})

@app.route('/admin/approve/<username>', methods=['POST'])
def approve_user(username):
    if session.get('user') != ADMIN_USER:
        return jsonify({'error': 'Unauthorized'}), 403
        
    if username in users_db:
        users_db[username]['plan'] = 'paid'
        users_db[username]['premium_days'] = 30
        return jsonify({'success': True})
    return jsonify({'success': False}), 404

@app.route('/broadcast', methods=['POST'])
def broadcast():
    return jsonify({'success': True})

if __name__ == '__main__':
    app.run(debug=True)