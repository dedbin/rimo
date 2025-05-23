'use client';

import Image from 'next/image';
import { useOrganization, useOrganizationList } from '@clerk/nextjs';
import { cn } from '@/lib/utils';
import { Hint } from '@/components/hint';

interface ItemProps {
  id: string;
  name: string;
  imageUrl: string;
}

export const Item = ({ id, name, imageUrl }: ItemProps) => {
  const { organization } = useOrganization();
  const { setActive } = useOrganizationList();

  const isActive = organization?.id === id;
  const onClick = () => {
    if (!setActive) return;
    setActive({ organization: id });
  };

  return (
    <li className="w-full flex justify-center">
      <div className="relative w-10 h-10">
        <Hint label={name} side="right" align="start" sideOffset={10}>
          <Image
            src={imageUrl}
            alt={name}
            fill
            onClick={onClick}
            className={cn(
              'rounded-md cursor-pointer opacity-75 hover:opacity-100 transition',
              isActive && 'opacity-100'
            )}
            sizes="40px"
            priority
          />
        </Hint>
      </div>
    </li>
  );
};
