"use client";

import { useState, useEffect } from "react";
import { useSession } from "next-auth/react";
import { Button } from "@/components/ui/button";
import { ExternalLink, CheckCircle, Lock, AlertCircle } from "lucide-react";

// 🎯 CONFIGURATION
const CHANNEL_LINK = "https://t.me/darkdomainhub";
const CHANNEL_NAME = "Dark Domain Hub";

// Moniepoint Payment Details
const PAYMENT_DETAILS = {
  bankName: "Moniepoint",
  accountNumber: "8100481004",
  accountName: "Daniel Dominion Folorunso",
};

export default function PremiumGate({ isPaid: initialIsPaid = false }) {
  const { data: session, status } = useSession();
  const [isJoined, setIsJoined] = useState(false);
  const [isPaid, setIsPaid] = useState(initialIsPaid);
  const [loading, setLoading] = useState(false);
  // Simulate checking if user joined (In a real app, this checks your DB)
  const handleJoinCheck = () => {
    // For now, we just mark it as joined when they click. 
    // Later, you can verify this via Telegram Bot API or manual admin approval.
    setIsJoined(true);
  };

  // Simulate payment verification (Admin verifies manually later)
  const handlePay = () => {
    setLoading(true);
    // Simulate a small delay for "verification"
    setTimeout(() => {
      setIsPaid(true);
      setLoading(false);
    }, 1000);
  };

  if (status === "loading") {
    return (
      <div className="flex items-center justify-center p-4">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-gray-900"></div>
        <span className="ml-2">Loading...</span>
      </div>
    );
  }

  if (!session) {
    return (
      <div className="bg-yellow-50 border-l-4 border-yellow-400 p-4">
        <p className="text-yellow-700">Please log in to view Premium details.</p>
      </div>
    );
          }
  return (
    <div className="max-w-md mx-auto bg-white rounded-xl shadow-md overflow-hidden md:max-w-2xl p-6 border border-gray-200">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-2xl font-bold text-gray-800 flex items-center gap-2">
          <Lock className="w-6 h-6 text-indigo-600" />
          Premium Access
        </h2>
      </div>

      {/* Channel Join Section */}
      <div className="mb-6">
        <h3 className="text-lg font-semibold text-gray-700 mb-2">Step 1: Join Our Channel</h3>
        <p className="text-sm text-gray-500 mb-3">
          You must join our Telegram channel to receive updates and access premium features.
        </p>
        <Button
          onClick={handleJoinCheck}
          disabled={isJoined}
          variant={isJoined ? "outline" : "default"}
          className="w-full bg-blue-600 hover:bg-blue-700 text-white"
          asChild
        >
          <a href={CHANNEL_LINK} target="_blank" rel="noopener noreferrer">
            {isJoined ? (
              <>
                <CheckCircle className="w-4 h-4 mr-2" /> Joined ({CHANNEL_NAME})
              </>
            ) : (
              <>
                <ExternalLink className="w-4 h-4 mr-2" /> Join {CHANNEL_NAME}
              </>
            )}
          </a>
        </Button>
      </div>

      <hr className="my-4" />

      {/* Payment Section */}
      <div className="mb-6">
        <h3 className="text-lg font-semibold text-gray-700 mb-2">Step 2: Make Payment</h3>
        <p className="text-sm text-gray-500 mb-3">
          Transfer the amount to the account below and click "I Have Paid".
        </p>
        <div className="bg-gray-50 p-4 rounded-lg border border-gray-200 mb-3">
          <p className="text-sm font-medium text-gray-700">Bank: <span className="text-gray-900 font-bold">{PAYMENT_DETAILS.bankName}</span></p>
          <p className="text-sm font-medium text-gray-700">Account Number: <span className="text-gray-900 font-bold">{PAYMENT_DETAILS.accountNumber}</span></p>
          <p className="text-sm font-medium text-gray-700">Account Name: <span className="text-gray-900 font-bold">{PAYMENT_DETAILS.accountName}</span></p>
        </div>
        <Button
          onClick={handlePay}
          disabled={isPaid || loading}
          className="w-full bg-green-600 hover:bg-green-700 text-white"
        >
          {loading ? "Verifying..." : isPaid ? "Payment Verified!" : "I Have Paid"}
        </Button>
      </div>
      Gray-900 font-bold">{PAYMENT_DETAILS.accountNumber}</span></p>
          <p className="text-sm font-medium text-gray-700">Name: <span className="text-gray-900 font-bold">{PAYMENT_DETAILS.accountName}</span></p>
        </div>
        
        <Button
          onClick={handlePay}
          disabled={isPaid || loading}
          className={`w-full ${isPaid ? 'bg-green-600 hover:bg-green-700' : 'bg-indigo-600 hover:bg-indigo-700'} text-white`}
        >
          {loading ? (
            <span className="animate-pulse">Verifying...</span>
          ) : isPaid ? (
            <>
              <CheckCircle className="w-4 h-4 mr-2" /> Payment Verified
            </>
          ) : (
            "I Have Paid"
          )}
        </Button>
      </div>

      {/* Final Status Message */}
      {isPaid && (
        <div className="bg-green-50 border border-green-200 rounded-lg p-4 text-center">
          <CheckCircle className="w-10 h-10 text-green-600 mx-auto mb-2" />
          <h3 className="text-lg font-bold text-green-800">You are now Premium!</h3>
          <p className="text-sm text-green-600">
            Welcome to Dark Domain Hub Premium. Enjoy unlimited access.
          </p>
        </div>
      )}
    </div>
  );
    }
      
