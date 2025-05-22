"use client";

import { useState, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Image as ImageIcon } from "lucide-react";
import { toast } from "sonner";

interface ImageUploadProps {
  onImageUploaded: (imageUrl: string) => void;
}

export const ImageUpload = ({ onImageUploaded }: ImageUploadProps) => {
  const [isUploading, setIsUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleClick = () => {
    if (fileInputRef.current) {
      fileInputRef.current.click();
    }
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    try {
      setIsUploading(true);
      
      const formData = new FormData();
      formData.append("file", file);

      const response = await fetch("/api/upload-image", {
        method: "POST",
        body: formData,
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || "Failed to upload image");
      }

      const data = await response.json();
      onImageUploaded(data.url);
      
      // Reset the file input
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
    } catch (error) {
      console.error("Error uploading image:", error);
      toast.error("Failed to upload image. Please try again.");
    } finally {
      setIsUploading(false);
    }
  };

  return (
    <>
      <input
        type="file"
        ref={fileInputRef}
        style={{ display: "none" }}
        accept="image/jpeg,image/png,image/gif,image/webp"
        onChange={handleFileChange}
      />
      <Button
        variant={isUploading ? "outline" : "board"}
        size="icon"
        onClick={handleClick}
        disabled={isUploading}
      >
        <ImageIcon />
      </Button>
    </>
  );
};
